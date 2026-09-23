# pi-capture — Track 1: the court-camera capture daemon

Replaces OBS. One headless service (`camd.py`) runs on each court's Raspberry Pi and does
what the club needs, driven by config + a tiny HTTP control API:

- **Teaching camera** → records a lesson to the NAS (no stream).
- **Court-4 open play** → live-streams to YouTube **and** records the session on demand.

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
