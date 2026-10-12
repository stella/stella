import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GENERATORS,
  allowedOutputs,
  generatorsForFiles,
  matchesGeneratedGlob,
} from "./generated-files";

// Generators that autofix may run because their output is a pure function of
// committed source: no network, secrets, clock, randomness, or untracked
// machine state. Each entry names what was checked.
const PURE_AUTOFIX = {
  // Reads `<dir>/en.json` alone and prints its key tree in source order.
  "i18n-messages-web": "packages/scripts/src/i18n-typegen.ts",
  "i18n-messages-landing": "packages/scripts/src/i18n-typegen.ts",
  "i18n-messages-transactional": "packages/scripts/src/i18n-typegen.ts",
  // Splices the static @stll/locales arrays between fixed markers.
  "prepaint-locales": "apps/web/scripts/sync-prepaint-locales.ts",
} as const;

const generator = (id: string) => {
  const found = GENERATORS.find((candidate) => candidate.id === id);
  if (!found) {
    throw new TypeError(`Unknown generator ${id}`);
  }
  return found;
};

test("pure generators are autofix-eligible and write only their own outputs", () => {
  for (const [id, script] of Object.entries(PURE_AUTOFIX)) {
    const entry = generator(id);
    expect(entry.autofix, id).toBe(true);
    expect(entry.outputKind, id).toBe("committed");
    expect(entry.write, id).toContain(script);
    // A refresh or network flag would make the output depend on the outside.
    expect(
      entry.write.some((part) => /refresh|fetch|network|update/u.test(part)),
      id,
    ).toBe(false);
  }
});

test("translation content never becomes an autofix output", () => {
  // `i18n:sync` copies English into other locales; that is translation
  // content, so no generator may write a locale catalogue.
  const catalogues = [
    "apps/web/src/i18n/langs/cs.json",
    "apps/web/src/i18n/langs/en.json",
    "apps/landing/src/i18n/messages/de.json",
    "packages/transactional/i18n/langs/sk.json",
  ];
  for (const entry of GENERATORS) {
    expect(entry.write.join(" "), entry.id).not.toMatch(/i18n:sync|--sync/u);
    for (const catalogue of catalogues) {
      expect(
        entry.outputs.some((output) => matchesGeneratedGlob(output, catalogue)),
        `${entry.id} writes ${catalogue}`,
      ).toBe(false);
    }
  }
  const selected = generatorsForFiles(["apps/web/src/i18n/langs/cs.json"]);
  expect(selected.map(({ id }) => id)).toContain("i18n-messages-web");
  const allowed = allowedOutputs(selected);
  expect(allowed).toContain("apps/web/src/i18n/langs/messages.gen.ts");
  for (const catalogue of catalogues) {
    expect(
      allowed.some((output) => matchesGeneratedGlob(output, catalogue)),
      catalogue,
    ).toBe(false);
  }
});

test("locale contract changes select the prepaint locale block", () => {
  expect(
    generatorsForFiles(["packages/locales/src/languages.ts"]).map(
      ({ id }) => id,
    ),
  ).toContain("prepaint-locales");
  expect(
    generatorsForFiles(["apps/landing/src/i18n/messages/en.json"]).map(
      ({ id }) => id,
    ),
  ).toContain("i18n-messages-landing");
  expect(
    generatorsForFiles(["packages/transactional/i18n/langs/en.json"]).map(
      ({ id }) => id,
    ),
  ).toContain("i18n-messages-transactional");
});

test("message type generation is byte-stable without any environment", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "i18n-typegen-"));
  try {
    writeFileSync(
      path.join(directory, "en.json"),
      JSON.stringify({ zeta: { b: "B {count}", a: "A" }, alpha: "Alpha" }),
    );
    const typegen = (...args: string[]) =>
      Bun.spawnSync(
        [
          process.execPath,
          "packages/scripts/src/i18n-typegen.ts",
          directory,
          ...args,
        ],
        {
          // Nothing but the binary search path: the output may not depend on
          // tokens, locale, time zone or any other variable.
          env: { PATH: process.env["PATH"] ?? "" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    const output = path.join(directory, "messages.gen.ts");
    expect(typegen().exitCode).toBe(0);
    const first = readFileSync(output, "utf-8");
    expect(typegen().exitCode).toBe(0);
    expect(readFileSync(output, "utf-8")).toBe(first);
    expect(typegen("--check").exitCode).toBe(0);
    // Keys keep en.json's order, so the declaration is reviewable as a diff.
    expect(first.indexOf('"zeta"')).toBeLessThan(first.indexOf('"alpha"'));
    expect(first.indexOf('"b"')).toBeLessThan(first.indexOf('"a"'));

    writeFileSync(
      path.join(directory, "en.json"),
      JSON.stringify({ alpha: "Alpha" }),
    );
    expect(typegen("--check").exitCode).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
