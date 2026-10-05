import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { SYSTEM_RUN_ACTOR_COUNTS } from "./actors";
import {
  MEMBER_RUN_MODULES,
  MEMBER_RUN_MODULES_ARE_NEVER_SYSTEM,
  SYSTEM_AUDIT_MODULES,
} from "./modules";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");
const API_SOURCE = path.join(REPO_ROOT, "apps/api/src");
const RECORD_CALL =
  /\brecordSystemAudit\(\s*[A-Za-z_$][\w$]*,\s*"(?<actor>system:[a-z0-9-]+)"/gu;

/** Each production file that records through `recordSystemAudit`, by actor. */
const recordersByActor = (): Map<
  string,
  { file: string; source: string }[]
> => {
  const recorders = new Map<string, { file: string; source: string }[]>();
  const glob = new Bun.Glob("**/*.ts");
  for (const file of glob.scanSync({ cwd: API_SOURCE })) {
    if (file.endsWith(".test.ts")) {
      continue;
    }
    const source = readFileSync(path.join(API_SOURCE, file), "utf-8");
    for (const match of source.matchAll(RECORD_CALL)) {
      const actor = match.groups?.["actor"];
      if (actor !== undefined) {
        const files = recorders.get(actor) ?? [];
        files.push({ file: `apps/api/src/${file}`, source });
        recorders.set(actor, files);
      }
    }
  }
  return recorders;
};

test("every registered system module exists", () => {
  for (const file of Object.keys(SYSTEM_AUDIT_MODULES)) {
    expect(existsSync(path.join(REPO_ROOT, file))).toBe(true);
  }
});

test("member-run modules are never system modules", () => {
  expect(MEMBER_RUN_MODULES_ARE_NEVER_SYSTEM).toBe(true);
  for (const file of MEMBER_RUN_MODULES) {
    expect(existsSync(path.join(REPO_ROOT, file))).toBe(true);
    expect(Object.keys(SYSTEM_AUDIT_MODULES)).not.toContain(file);
  }
});

test("every run actor records its runs, so a registered module is never silent", () => {
  const recorders = recordersByActor();
  expect(
    Object.keys(SYSTEM_RUN_ACTOR_COUNTS).filter(
      (actor) => !recorders.has(actor),
    ),
  ).toEqual([]);
});

// The lint rule exempts a registered module's writes on the strength of its
// actor's record, so the record must come from the module itself or from a
// file that imports it: a swapped or unrelated actor fails here.
test("every registered module is recorded by its own actor", () => {
  const recorders = recordersByActor();
  const unbound = Object.entries(SYSTEM_AUDIT_MODULES).flatMap(
    ([file, actor]) => {
      const specifier = `"@/api/${file.slice("apps/api/src/".length, -".ts".length)}"`;
      const bound = (recorders.get(actor) ?? []).some(
        (recorder) =>
          recorder.file === file || recorder.source.includes(specifier),
      );
      return bound ? [] : [`${file}: ${actor}`];
    },
  );
  expect(unbound).toEqual([]);
});
