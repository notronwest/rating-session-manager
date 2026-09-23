#!/bin/bash
# Idempotently mount the WMPC NAS video share on the mini at ~/wmpc-video (= VIDEO_DIR).
# The password comes from the login Keychain, so this never prompts (add it once — see README).
set -euo pipefail
NAS_USER="${WMPC_NAS_USER:-wmpc}"
SHARE="//${NAS_USER}@wstNas2.local/wmpc"
MNT="${HOME}/wmpc-video"
mkdir -p "$MNT"
# Already mounted and healthy? done.
if mount | grep -q " ${MNT} "; then exit 0; fi
# mount_smbfs reads the saved Keychain item for wstNas2.local, so no password on the command line or in argv.
/sbin/mount_smbfs "$SHARE" "$MNT"
