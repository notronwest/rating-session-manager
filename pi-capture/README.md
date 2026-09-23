# pi-capture — Track 1: the court-camera capture daemon

Replaces OBS. One headless service (`camd.py`), driven by config + a tiny HTTP control API,
covers every camera the club runs. It has two **source modes**:

- **`source: "rpicam"`** — opens an on-Pi camera. Used by:
  - **Teaching camera** → records a lesson to the NAS (no stream).
  - a future **court-native cam** → streams to YouTube **and** records on demand.
- **`source: "tcp"`** — ingests an **existing** H.264-over-TCP feed instead of a camera. Used by
  the **baseline camera already installed** (a Pi 5, hostname `Court4Cam`, at `10.0.0.120:8555`): camd runs on
  the **mini**, consumes that feed, and replaces the **hand-run OBS** — streaming to YouTube and
  recording to the NAS on demand (an optional CV relay leg is available but off by default). Because
  every leg is `-c copy` (no transcode), this also removes the old fan-out's ~17% frame drop.

`camd` never decides *when* to record — the **mini** does (it watches the Court Reserve
schedule and calls `/record/start|stop` at session boundaries), or a person does via the
same API. `camd` just runs the pipeline and reports status.

> **D-0010:** rating-session-manager owns video. Recordings land on the NAS under
> `VIDEO_DIR`; the existing pb.vision pipeline (`src/pbvision/*`) takes marked sessions from
> there. This is the ingest half — capture → NAS.

## Data path
```
Pi camera ─► rpicam-vid (H.264) ─► ffmpeg ─┬─► RTMP → YouTube        (open play only)
                                           └─► .mp4 → NAS /mnt/wmpc-video/<court>/<date>/
mini  ─── mounts the same NAS at ~/wmpc-video (= VIDEO_DIR) ─── rating-session-manager reads it
```
One camera = one capture, so ffmpeg fans out; toggling record/stream rebuilds the one
pipeline (a ~1s blip at session boundaries only).

## On the Pi (Raspberry Pi OS Bookworm, Camera Module 3)

1. **Camera + tools:** `sudo apt update && sudo apt install -y rpicam-apps ffmpeg cifs-utils`
   (rpicam-apps ships `rpicam-vid`). Confirm the camera: `rpicam-hello --list-cameras`.
2. **User + group:** run as a `wmpc` user in the `video` group (`sudo usermod -aG video wmpc`).
3. **Mount the NAS on the Pi** at `/mnt/wmpc-video` (SMB/cifs). Put the NAS login in a
   root-only credentials file and reference it from `/etc/fstab` so it remounts on boot:
   ```
   # /etc/wmpc/nas.cred  (chmod 600, root)
   username=wmpc
   password=<nas password>
   # /etc/fstab
   //wstNas2.local/wmpc  /mnt/wmpc-video  cifs  credentials=/etc/wmpc/nas.cred,uid=wmpc,gid=wmpc,_netdev,nofail  0  0
   ```
   `sudo mkdir -p /mnt/wmpc-video && sudo mount -a` — confirm you can write there.
4. **Deploy camd:** copy this folder to `/opt/wmpc/pi-capture/`, and the config to
   `/etc/wmpc/camera.conf` (from `camera.conf.example`):
   - **Teaching Pi (Thursday target):** `court: "teaching"`, `youtube_key: ""` → **record only**.
   - **Court-4 Pi:** `court: "court4"`, `youtube_key: "<the YouTube stream key>"` → streams + records.
5. **Service:** `sudo cp wmpc-camera.service /etc/systemd/system/ && sudo systemctl enable --now wmpc-camera`.
   Check: `curl -s localhost:8080/status | jq`.

## On the mini (the NAS + VIDEO_DIR)

The mini reads recordings from the same NAS. The share needs a login, so make the mount
reboot-proof and keychain-backed (no password on disk):

1. **Save the NAS password to the login Keychain once** — Finder → *Go → Connect to Server*
   → `smb://wstNas2.local/wmpc` → check *Remember this password in my keychain*. (Or
   `security add-internet-password -a wmpc -s wstNas2.local -r "smb " -w`.)
2. Install the auto-mount agent (self-heals every 5 min):
   ```
   sudo mkdir -p /opt/wmpc/pi-capture/mini && sudo cp mini/mount-nas.sh /opt/wmpc/pi-capture/mini/
   cp mini/com.wmpc.nas-mount.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.wmpc.nas-mount.plist
   ```
   `~/wmpc-video` is now `VIDEO_DIR`. (The mini auto-logs-in, so the LaunchAgent runs on boot.)

## Baseline camera — ingest the existing feed on the mini (replaces OBS)

The baseline camera is **already installed**: a **Pi 5** (hostname `Court4Cam`, `10.0.0.120`) emitting a raw
H.264 elementary stream over TCP on **:8555**. Today **OBS** on the mini reads that feed and
streams it to YouTube by hand. (`court-vision/fanout.sh` is **retired** — no longer used.) We
don't touch the Pi — we point camd at the feed it already emits and retire OBS.

> **Use the Pi's IP in `input_url`, not its `.local` mDNS name.** camd runs under launchd, and
> launchd-spawned ffmpeg cannot resolve `.local` names (it fails with *"Failed to resolve
> hostname"* even when the shell can `ping` it) — so give the Pi a **DHCP reservation** on the Orbi
> (here `10.0.0.120`) and use that IP. This bit us during the first cutover.

> **Only one consumer can read the Pi's single TCP feed.** So camd *becomes* that consumer:
> hand-run OBS is stopped at cutover and camd takes over — streaming to YouTube and recording to
> the NAS on demand, all `-c copy` (no transcode → no ~17% frame drop).

> **Two Sequoia gotchas that cost real time at the first cutover, both handled in code:**
> 1. **Timestamps** — a raw H.264 elementary stream has no PTS, and FLV/RTMP + mp4 muxers reject
>    packets with no PTS (`Packet is missing PTS`, the copy dies). OBS never hit this because it
>    re-encoded; our `-c copy` doesn't, so camd adds `-use_wallclock_as_timestamps 1` to stamp the
>    input. 2. **Local Network Privacy** (macOS 15) — a launchd daemon must be granted Local Network
>    access to reach LAN IPs; without it every connection fails as *"No route to host"* even though
>    the shell (which has the grant) reaches the Pi fine. See the deploy step below.

**On the mini:**

1. **ffmpeg present:** `brew install ffmpeg` (the plist's `PATH` points at `/opt/homebrew/bin`).
2. **Config** from `camera.conf.baseline.example` → `/opt/wmpc/pi-capture/mini/camera.baseline.conf`.
   Set:
   - `youtube_key` — **the stream key currently in OBS** (Settings → Stream → copy it out). This is
     the one secret; it lives only in this root-readable file, never in the repo.
   - `output_dir` — the mini's NAS mount (e.g. `/Users/wmpc/wmpc-video`).
   - `cv_relay` — leave `""`. (Only set an mpegts UDP target here if a computer-vision consumer is
     ever running again; camd will keep that leg alive alongside the stream.)
3. **Source** the daemon: `sudo mkdir -p /opt/wmpc/pi-capture/pi-capture-src && sudo cp *.py /opt/wmpc/pi-capture/pi-capture-src/`.
4. **Grant Local Network access (macOS 15+, REQUIRED):** the launchd daemon can't reach the Pi's LAN
   IP until it's allowed. System Settings → **Privacy & Security → Local Network** → enable the entry
   for the daemon (`Python`/`ffmpeg`/`com.wmpc.camd`). If it isn't listed yet, run camd once in the
   foreground (`/usr/bin/python3 /opt/wmpc/pi-capture/pi-capture-src/camd.py --config …`) to make it
   register / prompt, click **Allow**, then Ctrl-C. Without this, camd fails every connect as
   *"No route to host"* even though the shell reaches the Pi.
5. **Cutover (live stream — do this deliberately):** quit **OBS** so the single TCP feed is free,
   then load camd:
   ```
   cp mini/com.wmpc.camd.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.wmpc.camd.plist
   curl -s localhost:8080/status | jq        # source:"tcp", streaming:true, pipeline_up:true
   ```
   Confirm the YouTube stream is live, then you're off OBS. `KeepAlive` restarts camd if it dies;
   camd self-heals the ffmpeg pipeline (and reconnects if the Pi feed blips).
6. **Roll back** (if needed): `launchctl unload ~/Library/LaunchAgents/com.wmpc.camd.plist`, then
   reopen OBS as before.

Recording a session is the same API as any camera (`POST /record/start` → `/record/stop`); files
land on the NAS under `output_dir/court4/<date>/`.

## Control API (what the mini / dashboard / a person calls)
`POST /record/start {"name":"optional-label"}` · `POST /record/stop` · `POST /stream/start` ·
`POST /stream/stop` · `GET /status`. e.g. start a lesson recording by hand:
```
curl -s -XPOST http://<pi-ip>:8080/record/start -d '{"name":"beginner-clinic"}'
curl -s -XPOST http://<pi-ip>:8080/record/stop
```
Recordings land at `/mnt/wmpc-video/<court>/<YYYY-MM-DD>/<court>-<HHMMSS>[-name].mp4`
(written to a hidden temp name, atomically renamed on clean stop).

## Thursday MVP (teaching)
Teaching Pi, `youtube_key:""`, record-only. Prove: `POST /record/start` → play a bit →
`POST /record/stop` → the mp4 appears on the NAS and the mini sees it at `~/wmpc-video`.
Then wire the mini's CR-schedule trigger (next piece) to call start/stop automatically.

## NOT here yet (next pieces)
- **Mini CR-schedule orchestrator:** watch CRAPI bookings → call `/record/start|stop` at
  lesson/open-play boundaries (the automatic trigger). Manual curl works today.
- **Mark-for-analysis → pb.vision:** flag a session → hand it to the existing `src/pbvision`
  pipeline. (Track 3 / the "import into TSA" hurdles.)
