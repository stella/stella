import { expect, test } from "bun:test";

import { checkParserVersions, comparisonBase } from "./check-parser-versions";

const INGESTION = "apps/api/src/handlers/case-law/ingestion/";
const ADAPTERS = `${INGESTION}adapters/`;
const PARSERS = `${INGESTION}parsers/`;

type FixtureOptions = {
  versions?: Partial<Record<"A" | "B" | "C", number>>;
  adapters?: readonly ("A" | "B" | "C")[];
  parserSources?: Partial<Record<"A" | "B" | "C", string>>;
  helperSource?: string;
  markerSource?: string;
  missingVersion?: "A" | "B" | "C";
  bareVersion?: boolean;
};

const fixture = ({
  versions = {},
  adapters = ["A", "B"],
  parserSources = {},
  helperSource = "export const helper = () => 'base';\n",
  markerSource = "",
  missingVersion,
  bareVersion = false,
}: FixtureOptions = {}): Map<string, string> => {
  const entries = adapters
    .map((key) => `[ADAPTER_KEYS.${key}]: Adapter${key}`)
    .join(",\n  ");
  const imports = adapters
    .map(
      (key) =>
        `import { Adapter${key} } from "./adapter-${key.toLowerCase()}";`,
    )
    .join("\n");
  const versionEntries = adapters
    .map((key) => `[ADAPTER_KEYS.${key}]: ${versions[key] ?? 1}`)
    .join(",\n  ");
  const files = new Map<string, string>([
    [
      `${ADAPTERS}adapter-registry.ts`,
      [
        'import { ADAPTER_KEYS } from "../ingestion-constants";',
        imports,
        `export const ADAPTER_REGISTRY = {\n  ${entries},\n};`,
        "export const IMPORT_REGISTRY = {};",
      ].join("\n"),
    ],
    [
      `${INGESTION}ingestion-constants.ts`,
      [
        'export const ADAPTER_KEYS = { A: "test-a", B: "test-b", C: "test-c" };',
        "export const IMPORT_SOURCE_KEYS = {};",
        `export const PARSER_VERSIONS = {\n  ${versionEntries},\n};`,
        ...(bareVersion
          ? [`export const A_PARSER_VERSION = ${versions.A ?? 1};`]
          : []),
      ].join("\n"),
    ],
    [`${PARSERS}shared-helper.ts`, `${markerSource}${helperSource}`],
  ]);

  for (const key of adapters) {
    const keyLower = key.toLowerCase();
    const versionImport =
      bareVersion && key === "A"
        ? 'import { A_PARSER_VERSION } from "../ingestion-constants";'
        : 'import { ADAPTER_KEYS, PARSER_VERSIONS } from "../ingestion-constants";';
    let parserVersion = `PARSER_VERSIONS[ADAPTER_KEYS.${key}]`;
    if (missingVersion === key) {
      parserVersion = "MISSING_PARSER_VERSION";
    } else if (bareVersion && key === "A") {
      parserVersion = "A_PARSER_VERSION";
    }
    files.set(
      `${ADAPTERS}adapter-${keyLower}.ts`,
      [
        versionImport,
        `import { parse${key} } from "../parsers/parser-${keyLower}";`,
        `export const Adapter${key} = { parserVersion: ${parserVersion}, parse: parse${key} };`,
      ].join("\n"),
    );
    files.set(
      `${PARSERS}parser-${keyLower}.ts`,
      [
        'import { helper } from "./shared-helper";',
        parserSources[key] ?? `export const parse${key} = () => helper();\n`,
      ].join("\n"),
    );
  }
  return files;
};

const changed = (base: Map<string, string>, head: Map<string, string>) =>
  checkParserVersions({ base, head });

test("a parser change passes when its registered adapter version increases", () => {
  const base = fixture();
  const head = fixture({
    versions: { A: 2 },
    parserSources: { A: "export const parseA = () => 'changed';\n" },
  });

  expect(changed(base, head)).toEqual([]);
});

test("missing and equal bumps fail, catching merge-group version collisions", () => {
  const base = fixture();
  const parserSources = { A: "export const parseA = () => 'changed';\n" };
  const higherBase = fixture({ versions: { A: 2 } });

  expect(changed(base, fixture({ parserSources }))).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  ]);
  expect(
    changed(higherBase, fixture({ versions: { A: 2 }, parserSources })),
  ).toEqual([
    expect.stringContaining("test-a: parser version 2 must exceed base 2"),
  ]);
});

test("a shared helper change fans out to every importing adapter", () => {
  const base = fixture();
  const oneVersionBumped = fixture({
    versions: { A: 2 },
    helperSource: "export const helper = () => 'changed';\n",
  });
  const bothVersionsBumped = fixture({
    versions: { A: 2, B: 2 },
    helperSource: "export const helper = () => 'changed';\n",
  });

  expect(changed(base, oneVersionBumped)).toEqual([
    expect.stringContaining("test-b: parser version 1 must exceed base 1"),
  ]);
  expect(changed(base, bothVersionsBumped)).toEqual([]);
});

test("a newly added marker exempts only its changed file", () => {
  const base = fixture();
  const head = fixture({
    parserSources: {
      A: "// parser-output-unchanged: parser refactor only\nexport const parseA = () => helper();\n",
    },
  });

  expect(changed(base, head)).toEqual([]);
});

test("an old marker cannot exempt a later edit to the same file", () => {
  const base = fixture({
    parserSources: {
      A: "// parser-output-unchanged: earlier refactor\nexport const parseA = () => helper();\n",
    },
  });
  const head = fixture({
    parserSources: {
      A: "// parser-output-unchanged: earlier refactor\nexport const parseA = () => 'new behavior';\n",
    },
  });

  expect(changed(base, head)).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  ]);
});

test("a marker in another changed file does not exempt an unmarked parser change", () => {
  const base = fixture();
  const head = fixture({
    parserSources: { A: "export const parseA = () => 'changed';\n" },
    markerSource: "// parser-output-unchanged: helper refactor only\n",
    helperSource: "export const helper = () => 'changed';\n",
  });

  expect(changed(base, head)).toContain(
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  );
});

test("registry additions are discovered automatically and still require versions", () => {
  const withoutC = fixture();
  const addedC = fixture({ adapters: ["A", "B", "C"] });
  const base = fixture({ adapters: ["A", "B", "C"] });
  const changedC = fixture({
    adapters: ["A", "B", "C"],
    parserSources: { C: "export const parseC = () => 'changed';\n" },
  });
  const bumpedC = fixture({
    adapters: ["A", "B", "C"],
    versions: { C: 2 },
    parserSources: { C: "export const parseC = () => 'changed';\n" },
  });

  expect(changed(withoutC, addedC)).toEqual([]);
  expect(changed(base, changedC)).toContain(
    expect.stringContaining("test-c: parser version 1 must exceed base 1"),
  );
  expect(changed(base, bumpedC)).toEqual([]);
  expect(changed(base, fixture({ missingVersion: "A" }))).toContain(
    expect.stringContaining(
      "Registry entry ADAPTER_KEYS.A has no resolvable adapter or parser version",
    ),
  );
});

test("bare imported version constants remain supported", () => {
  const base = fixture({ bareVersion: true });
  const head = fixture({
    bareVersion: true,
    versions: { A: 2 },
    parserSources: { A: "export const parseA = () => 'changed';\n" },
  });

  expect(changed(base, head)).toEqual([]);
});

test("adapter-local output changes require a bump", () => {
  const base = fixture();
  const head = fixture();
  const adapter = `${ADAPTERS}adapter-a.ts`;
  head.set(
    adapter,
    `${head.get(adapter)}\nexport const assemble = () => 'changed output';\n`,
  );
  expect(changed(base, head)).toContain(
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  );
});

test("unresolved repository dependencies fail closed", () => {
  const base = fixture();
  const head = fixture();
  head.set(
    `${PARSERS}parser-a.ts`,
    'import { missing } from "./missing-parser"; export const parseA = () => missing();',
  );
  expect(changed(base, head)).toContain(
    expect.stringContaining("Unresolved repository import ./missing-parser"),
  );
});

test("version-only edits do not force unrelated bumps through a shared constants import", () => {
  const base = fixture();
  const head = fixture({ versions: { A: 2 } });
  for (const tree of [base, head]) {
    tree.set(
      `${PARSERS}shared-helper.ts`,
      'import { ADAPTER_KEYS } from "../ingestion-constants"; export const helper = () => ADAPTER_KEYS.A;',
    );
  }
  expect(changed(base, head)).toEqual([]);
});

test("the queue compares against its exact base while pull requests use the merge-base", () => {
  const commands: string[][] = [];
  const runGit = (args: string[]) => {
    commands.push(args);
    return {
      type: "ok",
      output: new TextEncoder().encode(
        args.at(0) === "rev-parse" ? "queue-base" : "fork-base",
      ),
    } as const;
  };
  const queue = comparisonBase({
    event: "merge_group",
    base: "queue-base",
    head: "queue-head",
    runGit,
  });
  const pullRequest = comparisonBase({
    event: "pull_request",
    base: "main-head",
    head: "pr-head",
    runGit,
  });
  expect(commands).toEqual([
    ["rev-parse", "--verify", "queue-base^{commit}"],
    ["merge-base", "main-head", "pr-head"],
  ]);
  expect(queue.type).toBe("ok");
  expect(pullRequest.type).toBe("ok");
  // Both PRs pass at their fork point; the second fails after the first bump
  // becomes the queue base, so it cannot publish another change at version 2.
  const second = fixture({
    versions: { A: 2 },
    parserSources: { A: "export const parseA = () => 'second fix';" },
  });
  expect(changed(fixture(), second)).toEqual([]);
  expect(changed(fixture({ versions: { A: 2 } }), second)).toContain(
    expect.stringContaining("test-a: parser version 2 must exceed base 2"),
  );
  expect(
    comparisonBase({
      event: "merge_group",
      base: "",
      head: "queue-head",
      runGit,
    }).type,
  ).toBe("failed");
  expect(commands).toHaveLength(2);
});

test("published packages are external while unresolved workspace exports fail closed", () => {
  const base = fixture();
  const head = fixture();
  for (const tree of [base, head]) {
    tree.set(
      `${PARSERS}shared-helper.ts`,
      'import { text } from "@stll/docx-core/model"; export const helper = <T>(value: T) => text(value);',
    );
  }
  expect(changed(base, head)).toEqual([]);
  head.set(
    "packages/docx-core/package.json",
    JSON.stringify({ exports: { "./other": "./src/other.ts" } }),
  );
  expect(changed(base, head)).toContain(
    expect.stringContaining(
      "Unresolved repository import @stll/docx-core/model",
    ),
  );
});
