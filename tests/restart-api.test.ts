// rsm#116. restart-api.sh / install-api.sh decision paths that need no launchd:
// a failed lsof lookup must never read as "nothing is running", and the
// installer must refuse while the system daemon's plist exists.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(import.meta.dirname, "..");

function fixture(lsofBody: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-api-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "server.js"), "");
  let lsof = path.join(dir, "no-such-lsof");
  if (lsofBody !== null) {
    lsof = path.join(dir, "lsof");
    fs.writeFileSync(lsof, `#!/bin/sh\n${lsofBody}\n`, { mode: 0o755 });
  }
  return { dir, lsof };
}

function restart(lsof: string, dir: string, extra: Record<string, string> = {}) {
  return spawnSync("bash", [path.join(REPO, "scripts/restart-api.sh")], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin", SM_ROOT: dir, SM_LSOF: lsof, SM_LAUNCHCTL: "/usr/bin/false",
      SM_SYSTEM_PLIST: path.join(dir, "absent.plist"), PORT: "39999", ...extra,
    },
  });
}

test("lsof missing is a failure, not 'nothing running'", () => {
  const { dir, lsof } = fixture(null);
  const r = restart(lsof, dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /lsof not found/);
  assert.doesNotMatch(r.stdout, /leaving as-is/);
});

test("lsof erroring (exit 2) is a failure, not 'nothing running'", () => {
  const { dir, lsof } = fixture("exit 2");
  const r = restart(lsof, dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /lsof failed/);
  assert.doesNotMatch(r.stdout, /leaving as-is/);
});

test("lsof exit 1 with no output means nothing is listening: leave as-is", () => {
  const { dir, lsof } = fixture("exit 1");
  const r = restart(lsof, dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /leaving as-is/);
});

test("system daemon path: lookup failure is reported, no second copy started", () => {
  const { dir, lsof } = fixture("exit 2");
  const plist = path.join(dir, "ai.wmpc.sessions.plist");
  fs.writeFileSync(plist, "");
  const r = restart(lsof, dir, { SM_SYSTEM_PLIST: plist });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /System LaunchDaemon/);
  assert.doesNotMatch(r.stdout, /Starting API/);
});

test("SKIP_API_RESTART=1 still skips", () => {
  const { dir, lsof } = fixture(null);
  const r = restart(lsof, dir, { SKIP_API_RESTART: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skipping/);
});

test("install-api.sh refuses while the system daemon plist exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-api-"));
  const plist = path.join(dir, "ai.wmpc.sessions.plist");
  fs.writeFileSync(plist, "");
  const r = spawnSync("bash", [path.join(REPO, "scripts/install-api.sh")], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: dir, SM_SYSTEM_PLIST: plist },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /already runs the API as a system service/);
  assert.equal(fs.existsSync(path.join(dir, "Library")), false);
});
