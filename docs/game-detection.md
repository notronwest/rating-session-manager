# Game detection — design notes

A scoping document for the "split a session recording into per-game clips"
problem. Captures what we're trying to solve, what we don't yet know, the
design space, and a recommended path forward.

This is **not** a specification of what the code does today; it's a step
back to make sure the code we write next is informed by the problem rather
than the prior iterations. For what's currently shipped, see the section
"Current implementation".

---

## 1. Goal

A coach hands the system a long recording of one session (typically 60–90
minutes, one camera, fixed position, four players) and gets back **N
clean per-game video files** — each starting at the right serve and
ending at the right rally. The user-visible win is "drop the recording
in, walk away, come back to clips ready to upload." Everything below is
in service of that.

## 2. What "right" actually means

A clip is **right** when:

- it starts in the second or two before the first serve of that game
  (server already in position; not mid-serve, not mid-warmup),
- it ends just after the rally on the last point ends (no truncated
  rally, no long dead time),
- the *number* of clips matches the number of games actually played.

A clip is **wrong** when any of those fails. The current motion-only
detector trips most often on:

- **count mismatch** — produces 2 clips when 4 games were played,
  because between-game breaks were too short to register.
- **early starts** — clip begins mid-walk-back-to-position rather than
  at the serve. Players moving = motion above threshold, but it's not
  game motion yet.
- **late starts** — clip begins mid-rally because the algorithm missed
  the actual serve and locked onto the next motion peak.

## 3. Open questions

These are the things we **don't yet know** that any future algorithm
work depends on. Listed in priority order — the first two unblock the
most.

1. **Does the recording include audio?**
   Pickleball serves and rallies have a distinctive paddle/ball impact
   sound (sharp transient, ~2–4 kHz peak). Audio is orthogonal to all
   the visual variation that's been blowing up the motion detector
   (lighting, clothing, walking-around behaviour). If the OBS captures
   include audio, an audio-burst detector probably outperforms anything
   visual we can build, and we should switch tracks. Verify with
   `ffprobe` against any one session video.

2. **Is the expected game count knowable in advance?**
   "Find K-1 boundaries given K games happened" is an enormously
   easier problem than "discover an unknown number of boundaries". If
   a 90-minute Pro+3 booking always produces 4 games, the detector
   gets a strong prior — it can rank candidate boundaries and pick the
   top 3 instead of having to rule each one in or out individually.
   Probably derivable from CR booking duration and format type.

3. **What do between-game transitions look like at WMPC, specifically?**
   The motion-only algorithm assumes 30s+ breaks (drink water, talk,
   walk back). Real WMPC sessions sometimes roll game-to-game in
   under 10 seconds. That's not a tuning fix — it's a different
   signal-environment, and detection has to pivot.

4. **Is the camera fixed across sessions?**
   If yes, a one-time calibration of court corners + baselines opens
   up spatial reasoning (e.g. "near baseline" vs "far baseline" zones)
   that doesn't need to be re-derived per session.

5. **What's between-game noise?** Players walking off-frame, sitting on
   a bench, ball-collection, paddle-spinning — each has a distinct
   motion fingerprint. Worth characterising once with a short labelled
   recording.

6. **How forgiving can the algorithm be?** If the clip starts 5 seconds
   too early, does that break the downstream pb.vision pipeline? (We
   know it doesn't — pb.vision tolerates pre-serve content fine.) That
   shapes how aggressively we trim.

## 4. Design space

Approaches, ordered by what we'd reach for **with no prior commitments**.
Each is judged on accuracy ceiling, engineering cost, and how it
degrades when assumptions break.

### 4.1 User-anchored boundaries (manual)

Coach scrubs through the recording and clicks "Game N starts here"
four times. ffmpeg cuts. Total time ~3 minutes per session. **Works
perfectly. Always.**

This is the boring baseline. It's what every other approach has to
beat to be worth building. Worth keeping as a fallback even when an
automatic detector exists — there will always be edge cases.

### 4.2 Audio-driven detection

Detect paddle/ball impact transients. Group impacts into bursts; a
"game" is a sustained burst, an inter-game break is a gap.

- **Strengths:** orthogonal to camera/lighting; the sound is invariant.
- **Weaknesses:** ambient noise (other courts, music), audio quality
  variation, requires audio in the source.
- **Engineering:** small. `librosa` + a peak detector. Maybe 200 LOC.
- **Worth building?** Yes if audio is recorded — top of the list.

### 4.3 Pose / player tracking

Off-the-shelf pose model (YOLO-pose, MediaPipe) finds the four players.
"Game in progress" = "4 players, two per side, mostly inside the court".
"Between games" = "players in arbitrary positions or out of frame".

- **Strengths:** directly models the concept of "game".
- **Weaknesses:** runtime cost, model fragility (occlusion, low light),
  another dependency to babysit.
- **Engineering:** moderate. ~500–1000 LOC, plus model bundle.
- **Worth building?** Maybe as a final-mile signal that votes alongside
  motion/audio. Not a standalone v1.

### 4.4 Motion magnitude (current implementation)

Sum motion in the court ROI per frame; find sustained low-motion runs
as breaks. Cuts placed between breaks.

- **Strengths:** light (OpenCV only), fast, easy to reason about.
- **Weaknesses:** cannot distinguish "player walking back" from "rally
  about to start" — they look the same to a magnitude-only signal.
  Hits the count-mismatch failure mode hard when between-game breaks
  are short.
- **Where it stands:** see "Current implementation" below.

### 4.5 Spatially-aware motion

Same as 4.4 but with motion broken into sub-zones (near baseline,
kitchen / mid-court, far baseline). Adds the constraint that a serve
must originate on the near baseline and travel toward the far court —
which, per WMPC's rule "near side serves first", filters out the bulk
of false positives that 4.4 trips on.

- **Strengths:** uses domain knowledge for free; same OpenCV stack.
- **Weaknesses:** still motion-only at heart; still can't distinguish
  "warmup at near baseline" from "actual serve from near baseline".
- **Engineering:** moderate. Sub-zone polygons in `roi.json`, per-zone
  motion series, additional cut-placement logic.
- **Status:** queued as a follow-up task ("Level 3").

### 4.6 ML — labelled examples

Train a small frame-classifier ("is this a game frame?") or sequence
model on labelled SRTs.

- **Strengths:** highest accuracy ceiling; handles messy real-world
  variation that hand-engineered detectors can't.
- **Weaknesses:** requires labelled data; needs retraining as cameras /
  conditions change; opaque (hard to debug "why did it cut here?").
- **Engineering:** large. Labelling tool, training loop, inference
  packaging.
- **Worth building?** Only if 4.2 / 4.5 hit a ceiling.

### 4.7 Human-corrected best-guess (system, not algorithm)

The detector produces best-guess cuts. The UI shows each candidate cut
with a 5-second preview, ± nudge buttons, and a "looks right" approval.
The coach sweeps through in seconds per cut. Approval is the
quality-control gate — not algorithm confidence.

This is **probably the right top-level answer regardless of which
detector we pick underneath**. "Flawless" automatic detection is a
long chase that may be unwinnable. "Confident-with-fast-correction" is
shippable now and decouples algorithm work from operator throughput.

## 5. Recommendation

Two parallel tracks. Both worth doing; UI work has compounding value.

### Track A — Better first-guess detection

Open questions 1 + 2 (audio? known game count?) gate this. Without
those answers, picking among 4.2 / 4.5 / 4.6 is a coin flip.

If audio is present in the source:
- Build 4.2 (audio-driven). One new signal probably gets to ~95%
  accuracy.
- Keep motion as a secondary check, voting alongside audio.

If no audio:
- Build 4.5 (spatially-aware motion). Use the "near side serves first"
  rule as a hard filter on cut placement.

Either way: **stop iterating without ground-truth data.** Three
manually-correct SRTs in `scripts/videos/test-fixtures/` would let any
algorithm change be measured rather than guessed at.

### Track B — Correction UI

Independently of detection quality:

- Per-segment preview thumbnail at the start frame
- 5-second scrub player at start and end of each segment
- ±5s / ±15s nudge buttons per boundary
- Per-session expected count vs detected count: "Expected ~4 games for
  an 80-minute Pro+3 booking; got 2. Review."

This makes detection failures **recoverable in seconds** instead of
fatal. It also unlocks the loud-failure alerting we want — when the
detected count strongly diverges from the expected count, fire an
alert with a "review now" link.

## 6. Decisions needed before more code

Three. Cheap to answer; without them, the next algorithm pass is
guesswork:

1. Audio in the recordings: yes / no.
2. Expected game count derivable from CR booking metadata: yes / no.
3. Where to invest first: Track A, Track B, or both. (Recommended:
   both, with Track B first because of compounding value.)

A small fourth: ground-truth SRTs for 3+ representative sessions.
Without them, every change to the detector is unmeasurable.

## 7. Current implementation

Whatever the next move is, this is what's in the repo today.

### 7.1 What runs

`scripts/videos/detect_games.py`. Invoked by `src/services/video-
processor.ts` from the `POST /api/sessions/:id/detect` route.

Pipeline:

1. Sample frames from the source video at `--sample-fps` (default 2)
   and compute per-frame court-region motion using OpenCV frame
   differencing within the polygon defined by `scripts/videos/roi.json`.
2. Smooth the motion series.
3. Identify sustained low-motion runs as candidate breaks. Reject
   short breaks if motion resumes within `--restart-lookahead`.
4. Place a cut at the END of each break. Trace the cut forward to the
   first sustained motion burst (the serve) and back-buffer slightly
   so we never clip the first frame of the serve.
5. Apply `--warmup` ignore at the start of the video so the first cut
   never lands inside the warmup period.
6. Filter out segments shorter than `--min-game`.
7. Write SRT for ffmpeg to consume during clip export.

### 7.2 Tunable parameters (UI-exposed)

| Knob | Default | Description |
|---|---|---|
| Warmup (sec) | 600 | Skip this many seconds at the start of the video. |
| Min Gap (sec) | 8 | Minimum sustained-low-motion duration to count as a break. |
| Long Break (sec) | 22 | Breaks longer than this are kept regardless of restart-soon. |
| Restart Look (sec) | 18 | If motion resumes within this many seconds, ignore the break. |
| Min Game (sec) | 300 | Drop segments shorter than this. |

### 7.3 Tunable parameters (CLI-only)

| Flag | Default | Description |
|---|---|---|
| `--burst-lookahead` | 60s | How far past a break to scan for the first serve burst. |
| `--burst-percentile` | 90 | Motion percentile that counts as a rally-level burst. |
| `--burst-back-buffer` | 0.5s | Back-off from the detected serve start so we never clip the first frame. |

### 7.4 Known limitations

- Motion-magnitude only; no spatial reasoning. Walking and rally look
  the same.
- No audio.
- No expected-count prior.
- Tuning the 8 knobs to fit one session usually breaks another.

### 7.5 Failure surfacing

- Python tracebacks are captured to stderr → forwarded into the
  session log.
- Non-zero exit fires a `Game detection crashed` Discord alert.
- A clean run that produces unexpectedly few/many segments **does not**
  alert. Adding the expected-count signal (open question 2) would let
  it.

## 8. References

- `scripts/videos/detect_games.py` — the detector.
- `scripts/videos/roi.json` — the court polygon.
- `scripts/videos/export_from_srt.py` — clip export from the detector's
  SRT output.
- `src/services/video-processor.ts` — JS wrapper that spawns the
  Python.
- `src/routes/sessions.ts` — `/api/sessions/:id/detect` and
  `/api/sessions/:id/export` routes.
