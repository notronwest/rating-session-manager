// D-0243's enforcement, and it is the reason this test was written BEFORE the
// analyzer moved out of this repo: the record says the analyzer holds no
// caller's database key and knows nothing about a club, and an interface is only
// a boundary if something refuses to cross it.
//
// Against the code as it stood on 2026-10-27 this test FAILS — the one import
// in src/services/lesson-transcribe.ts was `../supabase.js`, so the analysis and
// the club's database were in the same module. That is the point of it.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

const DIR = path.join(import.meta.dirname, "..", "src", "analyzer");

function sources(): string[] {
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".ts")).map((f) => path.join(DIR, f));
}

/** A file with its comments removed. An import cannot live in one. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every `from "x"` and `import("x")` specifier in a file.
 *
 * Comments are stripped FIRST. The scan is a text match, and an ordinary
 * English sentence inside a comment — `... one thing from "another" ...` —
 * read as an import of a module called "another" and failed the gate on prose.
 * This narrows what the scanner sees, not what the rule allows: the assertion
 * below is unchanged, and an import in real code cannot hide in a comment.
 */
function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of code(src).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

test("the analyzer imports nothing but node builtins and itself", () => {
  const files = sources();
  assert.ok(files.length > 0, "no analyzer sources found — did the directory move?");
  for (const file of files) {
    for (const spec of specifiers(fs.readFileSync(file, "utf8"))) {
      const local = spec.startsWith("./") && !spec.includes("/../");
      assert.ok(
        BUILTIN.has(spec) || local,
        `${path.basename(file)} imports ${spec} — the analyzer may not depend on the club's code `
        + `or on a package. D-0243 clause 4: it holds no caller's database key and stores no media.`,
      );
    }
  }
});

test("the analyzer names no club path, host or table", () => {
  // Not style: a default like /Volumes/wmpc-video is how an analyzer quietly
  // becomes WMPC's again. Anything it reads is passed in by the caller.
  const banned = [
    /\/Volumes\//, /wmpc-video/, /opt\/wmpc/, /127\.0\.0\.1/, /localhost/,
    /supabase/i, /\blessons\b/, /camd/, /CRAPI/, /SERVICE_ROLE/,
  ];
  for (const file of sources()) {
    // Comments may discuss the club; code may not name it.
    const src = code(fs.readFileSync(file, "utf8"));
    for (const re of banned) {
      assert.equal(re.test(src), false,
        `${path.basename(file)} names ${re} in code — see D-0243 clause 4`);
    }
  }
});
