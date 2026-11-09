# lesson-transcribe — the coach's mic becomes the lesson's write-up

LP-08, issue #74. Architecture: **D-0243** (*lesson analysis is a standalone
analyzer: a video link in, a versioned document out*), superseding D-0064. Spec:
daemon `agents/cto/initiatives/lesson-analyzer.md` for the analyzer and
`agents/chief-of-staff/initiatives/lesson-plan.md` for the coaching surface.
The analyzer's own repo is [`notronwest/lesson-analyzer`](https://github.com/notronwest/lesson-analyzer)
(private); read its `README.md` and `DEPLOYMENT.md` before changing anything
about the document.

> **The job is in two halves, in two repos, and the seam is the product.** The
> analysis is now `notronwest/lesson-analyzer` — its own private repo with its
> own tests and CI, installed here as a **dependency pinned to a commit**. It
> takes a video it does not own and returns one versioned document; it imports
> nothing but node builtins and names no club path, host or table, which its own
> boundary test refuses rather than asks for.
> `src/services/lesson-transcribe.ts` is the club half — the NAS, the settle
> window, the camd guard, the lesson row, the write-up draft — and it stays
> here. D-0243 clause 5 says what may move and what may not: the booking match,
> the retention clock and the write-up state stay with WMPC.
>
> **The pin is the interface.** A merge in the analyzer repo changes nothing
> here until `package.json`'s `#<sha>` is bumped, which is a reviewed commit in
> this repo. `tests/analyzer-contract.test.ts` refuses a branch pin and refuses
> a second copy of the analyzer under `src/`.

> **Where this came from.** On 2026-10-07 Ron was handed write-ups for two
> lessons. They were produced by a 14-line zsh script in his home directory on
> the mini (`~/wmpc-lessons/run.sh`), hand-run once, never in version control.
> It worked — 9,206 words from the 09-30 lesson, 4,803 from 10-06 — and it found
> a real bug: whisper **looped on silence** mid-file, and on the 09-27 clinic,
> whose mic was never connected, it invented 166 words out of digital silence.
> This component is that prototype made unattended, and both of those failures
> are closed below rather than inherited. The prototype and its transcripts are
> archived at `/Volumes/wmpc-video/transcripts/2026-10-07-whisper-prototype/`.

## What it does

```
every 10 min (launchd, user agent)
   │
   ├─ host gate: TRANSCRIBE-HOST == this machine?        ← committed fact
   ├─ mkdir lock: is a transcription already running?
   ├─ GUARD 1 (bytes):  a .recording.mp4 / .uploading temp in either tree?
   ├─ GUARD 2 (status): camd says recording / unreachable?   ← fail closed
   │
   ├─ reattachPending()  ─ transcripts waiting for a lesson to exist
   │
   └─ for the first eligible recording:
        ffprobe duration ─ under 10 min? a camera test, skip
        │
        ├── THE ANALYZER (the lesson-analyzer package, knows no club) ─────────
        │   in: { tenant, video (a URL or a path), scratchDir, asks }
        │   ffprobe -select_streams a       → no audio track? "silent", terminal
        │   ffmpeg  -vn -ac 1 -ar 16000      → wav   (nice 15, ITS OWN scratch)
        │   volumedetect ─ mean ≤ -70 dBFS? → result: "silent", no transcript
        │   whisper-cli --vad -mc 0          → .txt + .srt  in scratch, deleted
        │   returns ONE document: schema_version, tenant, result, source,
        │                         transcript { text, words, segments, srt }
        └───────────────────────────────────────────────────────────────────────
        assertSupportedDocument(doc)     ← refuses a major it cannot read
        WE write the .txt and .srt       ← the analyzer no longer writes our tree
        lessons.recording_ref == ref?    → lessons.transcript
                                         → TSA drafts what_we_did + homework
```

Transcripts land in `/Volumes/wmpc-video/transcripts/<date>/<name>.{txt,srt,json}`.

## Step one of D-0243, finished — 2026-11-07, schema 1.2

Until this landed the module was described as a service and was not one. Five
things were missing, and each was a different kind of blocker:

| the contract says | before | now |
|---|---|---|
| a tenant id, scoped from the first line (clause 4) | nothing anywhere | required on the input AND on the document; `assertTenant` refuses a job without one, and it is never defaulted |
| a URL in | `input.file` was a local path | `input.video` takes an `http(s)` URL or a path; every other ffmpeg protocol (`pipe:`, `concat:`, `rtmp:`) is refused rather than filtered |
| times on the transcript | whisper wrote an `.srt` the document threw away | `transcript.segments` and `transcript.srt`. This is what `cues`, `timeline` and `events` are built from — without it they had no times to point at |
| the caller owns nothing but the document | `outBase` made the analyzer write `.txt`/`.srt` into the club's NAS tree | the analyzer writes only inside its own scratch and deletes all of it; the club half writes the files where the club keeps them |
| an async job with a callback | a function call, nothing on a network | the analyzer's `jobs.ts` + `server.ts`: `POST /v1/jobs`, `GET /v1/jobs/:id`, a signed callback with a stable job id and a rising attempt number |

**`outBase` was the un-liftable one.** A service reachable over a network cannot
write into its caller's folder, so that single field was what made "move this
into its own repo" a rewrite rather than a move. It is gone.

**The `.txt` is load-bearing, not an artifact.** `reattachPending()` skips a
recording whose `.txt` is missing, so a transcript held only in the database
would never be re-attached when its lesson record appeared later. The club half
writes it before anything that can throw.

**What the network surface does NOT do.** It is not deployed and nothing points
at it: `com.wmpc.lesson-transcribe` still calls the analyzer in-process, beside
the files, which is what D-0243 clause 2 says WMPC should keep doing (the file is
already there, and it costs about a cent a lesson). The surface exists so the
lift is mechanical, and so the shape Ron approved — send a job, get called back —
is real rather than described. It holds no caller's database key; the only secret
it has is an API key that authorises analysis and nothing else.

**A finished document is held in memory only**, until it is delivered and its
retention window passes. Whether the engine should *persist* structured output is
the first thing D-0243 left unsettled, and an in-memory hand-off is the one shape
that pre-empts neither answer.

**Replay is answered on both ends.** A re-submitted `idempotencyKey` returns the
same job instead of a second hour of decode, and every callback carries
`job.id` with a rising `job.attempt` *inside* the document. A receiver whose
first write is permanent — the Academy's draft columns are write-once — can
therefore write once and ignore the rest. The receiver's own half is still owed.

## The two bugs from the prototype, and how each is closed

**Hallucination from silence.** whisper does not return "no speech"; it returns
confident words. The 09-27 clinic's "transcript" was 166 invented ones. So the
audio is measured with `volumedetect` *before* whisper runs, and a recording at
or below **-70 dBFS** is written up as `result: "silent"` with no transcript at
all. A dead mic now reads as a dead mic.

**Looping mid-file.** Fixed in two places, because one is not enough:
`--vad` with a Silero model drops non-speech before the decoder sees it, and
`--max-context 0` stops the decoder feeding its own previous output back as the
prompt — the feedback path that turns one bad segment into a loop that runs to
the end of the file. The installer treats the VAD model as **required**; the
self-test fails without it rather than quietly transcribing blind.

## Why it reads the NAS

`recordings-sync.sh` copies a finished recording to the NAS, verifies it by
sha256, and only then prunes the local copy — so on a healthy mini
`/opt/wmpc/recordings/teaching/` is **empty** (verified 2026-10-13: every date
directory there held no files). The NAS copy is the one that reliably exists. A
local copy is used when it happens to be present, and never depended on.

A file at its **final name** on the NAS is complete: sync writes
`.<name>.uploading` and `mv`s it into place only after verifying, precisely so a
downstream reader cannot mistake a partial copy for a finished recording.
Skipping dotfiles is therefore sufficient.

⚠️ **The slow step is reading the NAS, and it is not this job's bug.** The
prototype took 44 minutes to extract audio from a 2.2 GB file — about 0.8 MB/s,
which is the mini reaching the share over **Wi-Fi at ~9 Mbps** because its
gigabit NIC sits below Wi-Fi in the network service order. That is an open item
on Ron's ledger (and D-0069). Until it is fixed, "transcribed within an hour of
closing" holds for a 75-minute lesson and not much more. `maxPerRun: 1` exists
for the same reason.

## Why it does not time-match

LP-07 (#73) owns matching a recording to a lesson by time window. This job looks
up `lessons.recording_ref` and nothing else. Matching a second way here would be
two sources of truth for one question (D-0049) and would have to be torn out
when LP-07 lands.

**Until LP-07 lands, a transcript is simply "pending".** It sits in the store,
and `reattachPending()` retries on every tick — so the day a lesson gets a
`recording_ref`, the next tick attaches text that has been ready all along. No
rework, and nothing is lost in the interval.

## Infra intake (`daemon/infrastructure/INFRA-INTAKE.md`)

| # | Question | Answer |
|---|---|---|
| 1 | Unattended? | Yes. launchd every 10 min, no human in any path. `RunAtLoad false` so a reboot does not start an hour of ffmpeg while the SMB mount is still coming up. |
| 2 | How many machines? | Every machine has this repo; exactly one must act. |
| 3 | Singleton? | **Layer 1:** committed `TRANSCRIBE-HOST` names the machine; the wrapper exits 0 on any other, before Node starts. **Layer 2:** atomic `mkdir` lock with an 8-hour stale reclaim — a transcription legitimately runs for hours over SMB, and the ticker is every ten minutes. |
| 4 | Propagation? | `git pull` on the mini. ⚠️ **This repo has no auto-sync** — see the gap below. |
| 5 | Bootstrap? | One step, once: `./scripts/install-lesson-transcribe.sh`. It downloads both models, renders the plist **from the checkout it is run in**, loads the agent, and self-tests. |
| 6 | Self-heal? | The installer is idempotent — re-running repairs a missing model, a stale plist path, or an unloaded agent. The lock self-reclaims. A failed attach retries every tick forever. |
| 7 | Source of truth? | The repo: `TRANSCRIBE-HOST` (who), the plist template (when), this file (why). Machine-local state is only the log, the lock, and the unreachable counter. |
| 8 | Failure mode? | **Fail closed.** No `TRANSCRIBE-HOST` → refuse. camd unreachable → hold off (we cannot prove no lesson is recording) and exit **75**, which the wrapper reads as "did not run" and withholds the heartbeat, so a permanent block becomes watchdog silence rather than a cheerful beat over a dead job. Six consecutive unreachable ticks (~1 h) also post to Discord. |
| 9 | Secrets? | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from the repo `.env` (already present). `LESSON_DRAFT_URL` + `LESSON_DRAFT_SECRET` for the TSA draft function; without them transcripts still attach and the job logs that drafting is off. No Anthropic key on the mini — the AI call is TSA's, so the key stays in one place. |
| 10 | Observability? | One line per recording in `~/.local/state/wmpc-lesson-transcribe/transcribe.log` with words and seconds taken. `npm run transcribe:status` lists every recording and whether it is transcribed, pending attach, or silent. Discord on failure only. `heartbeat.sh lesson-transcribe` on a completed run; registered in daemon's `infrastructure/heartbeat/JOBS`. |
| 11 | Can the CoS reach it? | Yes: `npm run transcribe:status` and `npm run transcribe` under the host guard, both read-only-safe to invoke. She does not need the transcript text itself — it lives on the lesson. |

## Known gaps, stated rather than papered over

- **This repo has no automatic propagation.** Nothing pulls it on a schedule the
  way `daemon-sync` pulls daemon. A change to this component reaches the mini
  only when someone runs `git pull` there. That is pre-existing (see
  `DEPLOYMENT.md`) and is the honest answer to intake Q4, not a thing this PR
  fixed.
- **The lesson recorder is currently OFF.** `daemon/infrastructure/record-watchdog/RECORDER-ENABLED`
  is `no`, so no *new* lesson recordings are being made automatically. This job
  will work through what is already on the NAS; new supply needs the recorder
  turned on (a two-file commit, documented in daemon's `JOBS`).
- **Retention of transcripts is not set here.** D-0059's clock and D-0243's
  write-up exemption are LP-07's scope (#73). This job writes a transcript and
  does not delete anything.

## The analyzer moved out — 2026-11-08

Ron asked for it to have its own repo, and D-0243 clause 6 had already settled that
it would. The four analyzer sources left this repo with their history intact (a
`git subtree split`, four commits back to 2026-10-13) and are now
[`notronwest/lesson-analyzer`](https://github.com/notronwest/lesson-analyzer), private.

| | before | now |
|---|---|---|
| where the analysis lives | `src/analyzer/` in this repo | its own repo, installed as `lesson-analyzer` |
| how this job gets it | a relative import | a dependency pinned to a full commit sha |
| what guards the boundary | a test in this repo scanning a sibling directory | that test, in the analyzer's repo, with its own CI — plus a narrower rule for its `bin/` deployments |
| what this repo tests about the analysis | all 29 engine tests | 4 contract tests: the major it speaks, the symbols it exports, the caller's refusal of a future major, and that the pin is a commit with no second copy here |
| how a change reaches the club | immediately, on merge | when somebody bumps the pin — a reviewed commit here |

**Three things that did not move**, and the reason each one cannot (D-0243 clause 5,
which is a veto): `lesson-match.ts` and `lesson-sync.ts` reach Court Reserve with a key
that can charge a member's card; the retention clock cannot be separated from the
write-up state it exempts, or the cleanup job deletes footage a coach still needs; and
the scheduled job with its camera guard belongs where the recordings are.

**Updating the analyzer, end to end.** Merge there, then here: bump `#<sha>` in
`package.json`, `npm install`, open a PR, merge, and on the mini `git pull && npm run
build:only`. The last step is not optional — the launchd job runs `dist/`, so an
un-built pull leaves the old analyzer running with new source on disk.

**The ssh host alias in the dependency URL is deliberate.** `git@github-notronwest`
is an alias every fleet remote uses, present on the mini and the laptop, because
`git@github.com` resolves to a different GitHub account on at least one machine and
that account cannot read this private repo. On a machine without the alias `npm
install` fails loudly with a git authentication error; add the alias rather than
rewriting the URL.
