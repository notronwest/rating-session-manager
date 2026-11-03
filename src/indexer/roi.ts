// One shared place for a camera's court polygon (SP-11, D-0046).
//
// `<WMPC_ROI_DIR>/<camera>.json`, default /opt/wmpc/calibration/roi — outside
// any repo, so this indexer and the Court 4 switcher's judge read the SAME file
// instead of each carrying a copy. Format is detect_games.py's:
// {"type":"polygon","points":[[x,y],...]}.
import fs from "fs";
import path from "path";

export const DEFAULT_ROI_DIR = "/opt/wmpc/calibration/roi";

export function resolveRoi(
  camera: string, env: NodeJS.ProcessEnv = process.env, legacyFile?: string,
): { file: string; legacy: boolean } {
  if (!/^[a-z0-9_-]+$/i.test(camera)) throw new Error(`bad camera name "${camera}"`);
  const dir = env.WMPC_ROI_DIR || DEFAULT_ROI_DIR;
  const shared = path.join(dir, `${camera}.json`);
  if (fs.existsSync(shared)) return { file: shared, legacy: false };
  // The pre-SP-11 per-repo file still works so nothing breaks before the
  // calibration is moved, but it is flagged so the copy gets retired.
  if (legacyFile && fs.existsSync(legacyFile)) return { file: legacyFile, legacy: true };
  throw new Error(`no court polygon for "${camera}": expected ${shared}`);
}
