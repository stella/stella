import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { CaseLawWindowProfile } from "@/api/lib/files/windowed-read-surface";
import {
  WINDOWED_READ_DELEGATES,
  WINDOWED_READ_SURFACE,
} from "@/api/lib/files/windowed-read-surface";
import { caseLawWindowFixture } from "@/api/tests/helpers/case-law-windowed-read.fixture";

import exceptions from "./windowed-read-exceptions.json";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const profiles = {
  "case-law-reader": caseLawWindowFixture,
  "citation-passages": caseLawWindowFixture,
  "reader-answer": caseLawWindowFixture,
  "analysis-input": caseLawWindowFixture,
} as const satisfies Record<CaseLawWindowProfile, typeof caseLawWindowFixture>;

for (const profile of Object.keys(profiles)) {
  if (!(
    profile === "case-law-reader" ||
    profile === "citation-passages" ||
    profile === "reader-answer" ||
    profile === "analysis-input"
  )) {
    throw new Error(`Unregistered window fixture: ${profile}`);
  }
  test(`windowed read budget: ${profile}`, async () => {
    for (const source of ["store", "database"] as const) {
      const small = await profiles[profile](profile, { scale: 1, source });
      const large = await profiles[profile](profile, { scale: 10, source });
      const bytes = source === "store" ? "storageReadBytes" : "dbResultBytes";
      expect(large.cold[bytes]).toBeGreaterThan(small.cold[bytes] * 9);
      for (const result of [small, large]) {
        expect(result.cold.astParses).toBeGreaterThan(0);
        expect(result.warm.storageReadBytes).toBe(0);
        expect(result.warm.dbResultBytes).toBe(0);
        expect(result.warm.astParses).toBe(0);
        expect(result.warm.documentConversions).toBe(0);
        expect(result.warm.decryptedBytes).toBe(0);
        expect(result.warm.cacheHits).toBeGreaterThan(0);
      }
    }
  });
}

test("every registered document window has a live owner and executable budget guard", async () => {
  for (const [surface, entry] of Object.entries(WINDOWED_READ_SURFACE)) {
    const source = await Bun.file(`${sourceRoot}${entry.source}`).text();
    const guard = await Bun.file(`${sourceRoot}${entry.guard}`).text();
    if (entry.guard === "lib/case-law/windowed-read.postgres.test.ts") {
      expect(surface in profiles).toBe(true);
      expect(source).toMatch(
        new RegExp(`defineWindowedRead\\(\\s*"${surface}"`, "u"),
      );
    }
    expect(guard).toContain(entry.test);
  }
  const declared = new Set<string>();
  const excluded = new Set<string>();
  const owners = new Set<string>([
    ...Object.values(WINDOWED_READ_SURFACE).map(({ source }) => source),
    ...Object.keys(WINDOWED_READ_DELEGATES),
  ]);
  for await (const path of new Bun.Glob("**/*.ts").scan(sourceRoot)) {
    if (
      path.endsWith(".test.ts") ||
      path.endsWith(".fixture.ts") ||
      path.startsWith("scripts/") ||
      path.startsWith("tests/")
    ) {
      continue;
    }
    const source = await Bun.file(`${sourceRoot}${path}`).text();
    // A direct payload read beside window vocabulary must join the registry.
    // Complete-file consumers whose other phases/cursors are unrelated live
    // in the reviewed, shrinking exception ledger.
    if (
      /\b(readStoredFile|readDecisionReaderSource|readDecisionAnalysisAst|readCachedDecisionRowAst|readCachedDecisionAst)\s*\(/u.test(
        source,
      ) &&
      /\b(cursor|referenceCursor|maxChars|paragraphId|excerpt|phase)\b/u.test(
        source,
      ) &&
      !owners.has(path)
    ) {
      expect(path in exceptions, `Unregistered document window: ${path}`).toBe(
        true,
      );
      excluded.add(path);
    }
    for (const match of source.matchAll(
      /defineWindowedRead\(\s*"([a-z-]+)"/gu,
    )) {
      const surface = match[1];
      if (surface !== undefined) {
        expect(surface in WINDOWED_READ_SURFACE).toBe(true);
        expect(declared.has(surface)).toBe(false);
        declared.add(surface);
      }
    }
  }
  expect([...declared].toSorted()).toEqual(Object.keys(profiles).toSorted());
  expect([...excluded].toSorted()).toEqual(Object.keys(exceptions).toSorted());
});

test("document window exceptions only shrink from the merge base", () => {
  const cwd = fileURLToPath(new URL("../../../../../", import.meta.url));
  const ledger = "apps/api/src/lib/files/windowed-read-exceptions.json";
  const base = Bun.spawnSync(["git", "merge-base", "HEAD", "origin/main"], {
    cwd,
  });
  expect(base.exitCode).toBe(0);
  const revision = new TextDecoder().decode(base.stdout).trim();
  const present = Bun.spawnSync(
    ["git", "ls-tree", "--name-only", revision, ledger],
    { cwd },
  );
  expect(present.exitCode).toBe(0);
  if (new TextDecoder().decode(present.stdout).trim() === "") {
    return;
  }
  const prior = Bun.spawnSync(["git", "show", `${revision}:${ledger}`], {
    cwd,
  });
  expect(prior.exitCode).toBe(0);
  const existing: unknown = JSON.parse(new TextDecoder().decode(prior.stdout));
  expect(typeof existing).toBe("object");
  if (typeof existing !== "object" || existing === null) {
    return;
  }
  for (const [path, reason] of Object.entries(exceptions)) {
    expect(path in existing).toBe(true);
    expect(Reflect.get(existing, path)).toBe(reason);
  }
});
