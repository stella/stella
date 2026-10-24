import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildImportGraph } from "./api-test-impact";
import {
  AUTOFIX_PROTECTED_PATHS,
  isAutofixProtectedPath,
} from "./autofix-protected-paths";
import {
  allowedOutputs,
  GENERATORS,
  generatorsForFiles,
  matchesGeneratedGlob,
} from "./generated-files";

// Generators that autofix may run because their output is a pure function of
// committed source: no network, secrets, clock, randomness, or untracked
// machine state. Each entry names what was checked.
const PURE_AUTOFIX = {
  // Reads `<dir>/en.json` alone and prints its key tree in source order.
  "i18n-messages-landing": "packages/scripts/src/i18n-typegen.ts",
  "i18n-messages-transactional": "packages/scripts/src/i18n-typegen.ts",
  // Splices the static @stll/locales arrays between fixed markers.
  "prepaint-locales": "apps/web/scripts/sync-prepaint-locales.ts",
  // `generate` renders the env catalog and schema defaults plus the web
  // Dockerfile; only `doctor` reads the process environment or env files.
  "env-examples": "env:generate",
  // Renders the env catalog and the self-host contract, formatted by
  // bun fmt; `check` alone reads workflows and runs the manifest script.
  selfhost: "selfhost:generate",
  // Parsers and AST repairs are pure (no clock, network or database on the
  // re-parse path); it fails rather than re-stamping an analysis.
  "case-law-fixture-reparse": "apps/api/scripts/reparse-case-law-fixtures.ts",
  // Copies .ai/shared modules and skills (the pinned submodule, checked out
  // by autofix) and .ai/local* into AGENTS.md, GEMINI.md and skill copies,
  // staging in a temp directory; no network, clock or environment input.
  "ai-instructions": "sync-ai",
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

test("env and self-host generation never reads the process environment", () => {
  for (const [script, file] of [
    ["env:generate", "scripts/env-tool.ts generate"],
    ["selfhost:generate", "scripts/selfhost-tool.ts generate"],
  ] as const) {
    const scripts: unknown = JSON.parse(readFileSync("package.json", "utf-8"))[
      "scripts"
    ];
    expect(
      typeof scripts === "object" && scripts !== null
        ? Reflect.get(scripts, script)
        : undefined,
    ).toBe(`bun --no-env-file ${file}`);
  }
  const envTool = readFileSync("scripts/env-tool.ts", "utf-8");
  const generate = envTool.slice(
    envTool.indexOf("const generatedEnvironmentArtifacts = () => ["),
    envTool.indexOf("const generateEnvironmentArtifacts = () => {"),
  );
  expect(generate.length).toBeGreaterThan(0);
  expect(generate).not.toContain("process.env");
  // Every file the generator reads selects it when a pull request changes it.
  for (const [id, file] of [
    ["env-examples", "apps/web/Dockerfile"],
    ["env-examples", "apps/api/src/lib/rate-limit/budget-config-schema.ts"],
    ["selfhost", "apps/api/src/db/role-names.ts"],
    ["selfhost", "scripts/env-catalog.ts"],
  ] as const) {
    expect(
      generatorsForFiles([file]).map((entry) => entry.id),
      file,
    ).toContain(id);
  }
});

test("every module the case-law re-parse imports selects it", () => {
  // Inputs decide when autofix reruns a generator; a module that shapes the
  // output but is missing here would leave stale fixtures behind.
  const entry = "apps/api/scripts/reparse-case-law-fixtures.ts";
  const root = realpathSync(path.join(import.meta.dirname, ".."));
  const graph = buildImportGraph(root, [entry]);
  const closure = graph.closure(entry);
  // An unresolved or computed import would hide part of the graph.
  expect([...graph.failed].filter((file) => closure.has(file))).toEqual([]);
  expect(
    [...graph.computedImports].filter((file) => closure.has(file)),
  ).toEqual([]);
  expect(closure).toContain(
    "apps/api/src/handlers/case-law/ingestion/segmenter.ts",
  );
  const { inputs } = generator("case-law-fixture-reparse");
  expect(
    [...closure].filter(
      (file) => !inputs.some((input) => matchesGeneratedGlob(input, file)),
    ),
  ).toEqual([]);
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
  const selected = generatorsForFiles([
    "apps/landing/src/i18n/messages/cs.json",
  ]);
  expect(selected.map(({ id }) => id)).toContain("i18n-messages-landing");
  const allowed = allowedOutputs(selected);
  expect(allowed).toContain("apps/landing/src/i18n/messages/messages.gen.ts");
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

test("no autofix generator writes a protected decision record", () => {
  const witness = (glob: string) =>
    glob.replaceAll("**", "example/generated.json").replaceAll("*", "example");
  for (const entry of GENERATORS.filter(
    ({ autofix, outputKind }) => autofix && outputKind === "committed",
  )) {
    for (const output of entry.outputs) {
      expect(
        isAutofixProtectedPath(witness(output)),
        `${entry.id}: ${output}`,
      ).toBe(false);
      for (const pattern of AUTOFIX_PROTECTED_PATHS) {
        expect(
          matchesGeneratedGlob(output, witness(pattern)),
          `${entry.id}: ${output} covers ${pattern}`,
        ).toBe(false);
      }
    }
  }
  expect(generator("mcp-surface").autofix).toBe(false);
});
