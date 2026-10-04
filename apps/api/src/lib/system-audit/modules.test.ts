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

/** Every run actor some production module records through `recordSystemAudit`. */
const recordedActors = (): Set<string> => {
  const actors = new Set<string>();
  const glob = new Bun.Glob("**/*.ts");
  for (const file of glob.scanSync({ cwd: API_SOURCE })) {
    if (file.endsWith(".test.ts")) {
      continue;
    }
    const source = readFileSync(path.join(API_SOURCE, file), "utf-8");
    for (const match of source.matchAll(RECORD_CALL)) {
      const actor = match.groups?.["actor"];
      if (actor !== undefined) {
        actors.add(actor);
      }
    }
  }
  return actors;
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
  const recorded = recordedActors();
  expect(
    Object.keys(SYSTEM_RUN_ACTOR_COUNTS).filter(
      (actor) => !recorded.has(actor),
    ),
  ).toEqual([]);
});
