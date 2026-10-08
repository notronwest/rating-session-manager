# pi-capture — RETIRED here. The camera daemon lives in `daemon`.

**Nothing in this directory runs. Nothing in this directory ever ran from here.**
It held a copy of `camd.py` and its installers, last touched **2026-09-23**. The
code, the configs, the systemd unit and the launchd plists have been deleted.
Git history still has them (`89ad5c9`, `5108643`, `392a079`) if you need to read
what they said.

## Where camd actually lives

**`daemon/infrastructure/pi-capture/`** — `src/camd.py`, `src/switchd.py`,
`conf/*.template`, `tests/`, `DESIGN.md`, and the only sanctioned installer,
`deploy.sh`. That directory's `DESIGN.md` is explicit: *"Treat the mini as the
deploy target, this as the source."*

This is a decision, not a preference. **[D-0030](../DECISIONS.md)** — *Camera
control is fleet infrastructure; D-0010 governs video delivery, not capture* —
supersedes D-0010 and says it plainly: **"`camd` and the Pi emitters live in
daemon's `infrastructure/`"**, and the operator surface (status, go live,
start/stop recording) belongs in **club-dashboard**. D-0010's rules about
*delivering* a finished file to a member still bind this repo, and they are why
this directory looked reasonable in the first place — but they were never about
capture.

## Why this was deleted rather than left alone

The old `README.md` here was a confident, step-by-step **live-cutover runbook**,
and its steps were aimed at the running production stream:

- Step 3 was `sudo cp *.py /opt/wmpc/pi-capture/pi-capture-src/` — the exact path
  `daemon/infrastructure/pi-capture/deploy.sh` installs the real `camd.py` to. It
  would have **overwritten the live Court 4 daemon** with a 305-line ancestor of
  a file that is now 2,400+ lines.
- Step 4 loaded `com.wmpc.camd` — the **label of the camd instance currently
  streaming Court 4 to YouTube** — from a plist pointed straight at
  `tcp://10.0.0.120:8555`. The real deployment has `switchd` as the **single
  reader** of both Court 4 Pis (D-0046), with camd reading its loopback output;
  a second reader of that feed is refused, so this would have taken Court 4 down.
- It also told you to install `mini/mount-nas.sh`, which `deploy.sh` now
  **deletes** on sight as a retired credential-bearing script.

And the copy still carried three data-loss bugs that `daemon` has since found
and is fixing: a mid-record pipeline rebuild **truncating** the `.mp4` it was
recording into (ffmpeg cannot append to mp4, and the publish path only fired on
`record` going True→False), a shutdown **deadlock** from calling `reconcile()`
while already holding a non-reentrant `threading.Lock`, and a recording ended by
`active_end` **resuming the next morning onto a file literally named `None`**.

So this was not merely unused code. It was a dead mechanism that still looked
live, with instructions, aimed at production. That is precisely how the teaching
camera ran stale code as the wrong kind of launchd job for two days — the
incident `deploy.sh`'s own header exists to describe. The fix is one copy, in
`daemon`, installed by `deploy.sh`, gated on the committed `CAPTURE-HOST`.

## What this repo still owns

Recordings `camd` writes become **customer video** the moment this repo grants
access to them, and only then (D-0030, restating D-0010): the emailed six-digit
code, the download screen showing only that member's sessions, access logging,
Third Shot Academy branding, `VIDEO_DIR` on the NAS, 30-day grants. See
`src/pbvision/*` for the pipeline that picks marked sessions up from there.

**Do not re-vendor `camd` here.** If capture needs to change, change it in
`daemon/infrastructure/pi-capture/` and run `deploy.sh` on the capture host. If
you believe the boundary itself is wrong, supersede D-0030 through daemon's
register (`daemon/decisions/README.md`) — don't work around it.
