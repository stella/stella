import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkParserVersions,
  comparisonBase,
  readGitTree,
} from "./check-parser-versions";

const INGESTION = "apps/api/src/handlers/case-law/ingestion/";
const ADAPTERS = `${INGESTION}adapters/`;
const PARSERS = `${INGESTION}parsers/`;
const LEGISLATION_ADAPTERS =
  "apps/api/src/handlers/legislation/ingestion/adapters/";
const ENV_BASE = "apps/api/src/env-base.ts";
const TAGGED_ERRORS = "apps/api/src/lib/errors/tagged-errors.ts";
const LOGGER = "apps/api/src/lib/observability/logger.ts";
const VERSION = "apps/api/src/lib/version.ts";

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
    [ENV_BASE, "export const env = {};"],
    [TAGGED_ERRORS, "export class TaggedError extends Error {}"],
    [LOGGER, "export const logger = { info: () => {} };"],
    [VERSION, "export const APP_VERSION = 'test';"],
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

test("layout, comments and types never demand a bump, but output changes do", () => {
  const base = fixture();
  const reformatted = fixture({
    parserSources: {
      A: "// Reads one record.\nexport const parseA = (): string =>\n  helper( )\n",
    },
  });
  const changedOutput = fixture({
    parserSources: {
      A: "export const parseA = (): string =>\n  helper() + '!'\n",
    },
  });

  expect(changed(base, reformatted)).toEqual([]);
  expect(changed(base, changedOutput)).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  ]);
});

test("registered versions cannot decrease, including unchanged and exempted output", () => {
  const base = fixture({ versions: { A: 2 } });
  for (const parserSource of [
    "export const parseA = () => helper();\n",
    "export const parseA = () => 'changed';\n",
    "// parser-output-unchanged: refactor only\nexport const parseA = () => helper();\n",
  ]) {
    const head = fixture({
      versions: { A: 1 },
      parserSources: { A: parserSource },
    });
    expect(changed(base, head)).toEqual([
      "test-a: parser version 1 must not be lower than base 2",
    ]);
  }
});

test("an owner-scoped unchanged marker exempts only its registered source", () => {
  const base = fixture();
  const parserChanged = {
    markerSource:
      "// parser-output-unchanged: [test-a] A does not reach this shared change\n",
    helperSource: "export const helper = () => 'changed';\n",
  };
  expect(changed(base, fixture(parserChanged))).toEqual([
    expect.stringContaining("test-b: parser version 1 must exceed base 1"),
  ]);

  const unknownOwner = fixture({
    markerSource:
      "// parser-output-unchanged: [not-registered] no source owns this marker\n",
    helperSource: "export const helper = () => 'changed';\n",
  });
  expect(
    changed(base, unknownOwner).map((message) => message.split(":")[0]),
  ).toEqual(["test-a", "test-b"]);

  const malformedOwner = fixture({
    markerSource:
      "// parser-output-unchanged: [test_a] malformed owner syntax must not become global\n",
    helperSource: "export const helper = () => 'changed';\n",
  });
  expect(
    changed(base, malformedOwner).map((message) => message.split(":")[0]),
  ).toEqual(["test-a", "test-b"]);
});

test("adapter case-law helpers are owned without unrelated dependency fan-out", () => {
  const helper = "apps/api/src/lib/case-law/court.ts";
  const nestedHelper = "apps/api/src/lib/case-law/court-name.ts";
  const logger = "apps/api/src/lib/logger.ts";
  const base = fixture();
  const head = fixture();
  const bumped = fixture({ versions: { A: 2 } });
  for (const tree of [base, head, bumped]) {
    const adapter = `${ADAPTERS}adapter-a.ts`;
    tree.set(
      adapter,
      [
        'import { court } from "@/api/lib/case-law/court";',
        tree.get(adapter),
        "export const assemble = () => court();",
      ].join("\n"),
    );
    tree.set(
      helper,
      [
        'import { courtName } from "./court-name";',
        'import { log } from "../logger";',
        "export const court = () => { log(); return courtName(); };",
      ].join("\n"),
    );
    tree.set(nestedHelper, "export const courtName = () => 'base';");
    tree.set(logger, "export const log = () => {};");
  }
  for (const file of [helper, nestedHelper]) {
    const edited = new Map(head);
    const editedBumped = new Map(bumped);
    const source = `${base.get(file) ?? ""}\nexport const output = 'changed';`;
    edited.set(file, source);
    editedBumped.set(file, source);
    expect(changed(base, edited)).toEqual([
      expect.stringContaining("test-a: parser version 1 must exceed base 1"),
    ]);
    expect(changed(base, editedBumped)).toEqual([]);
  }
  head.set(logger, "export const log = () => 'changed';");
  expect(changed(base, head)).toEqual([]);
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

test("a change confined to an output boundary needs no version bump", () => {
  const base = fixture();
  const head = fixture();
  for (const tree of [base, head]) {
    tree.set(
      `${PARSERS}parser-a.ts`,
      'import { logger } from "@/api/lib/observability/logger";\nexport const parseA = () => { logger.info(); return "same"; };',
    );
  }
  head.set(LOGGER, "export const logger = { info: () => 'changed' };");

  expect(changed(base, head)).toEqual([]);
});

test("an output module reached only through a boundary is not owned", () => {
  const base = fixture();
  const head = fixture();
  const hidden = "apps/api/src/lib/output-hidden-by-logger.ts";
  for (const tree of [base, head]) {
    tree.set(
      `${PARSERS}parser-a.ts`,
      'import { logger } from "@/api/lib/observability/logger";\nexport const parseA = () => { logger.info(); return "same"; };',
    );
    tree.set(
      LOGGER,
      'import { hidden } from "../output-hidden-by-logger";\nexport const logger = { info: () => hidden };',
    );
    tree.set(hidden, "export const hidden = 'base';");
  }
  head.set(hidden, "export const hidden = 'changed';");

  expect(changed(base, head)).toEqual([]);
});

test("a stale output boundary fails", () => {
  const base = fixture();
  const head = fixture();
  head.delete(LOGGER);

  expect(changed(base, head)).toContain(
    `Parser output boundary does not exist in head tree: ${LOGGER}`,
  );
});

test("output boundaries cannot lie in any output-shaping root", () => {
  const roots = [
    `${ADAPTERS}boundary.ts`,
    `${LEGISLATION_ADAPTERS}boundary.ts`,
    `${PARSERS}boundary.ts`,
    "apps/api/src/lib/legal-search/parsers/boundary.ts",
    "apps/api/src/lib/case-law/boundary.ts",
    "packages/legal-ast/boundary.ts",
    "packages/text-normalize/boundary.ts",
    "packages/sha256/boundary.ts",
    "apps/api/src/lib/legal-search/ingestion-constants.ts",
  ];
  for (const boundary of roots) {
    const base = fixture();
    const head = fixture();
    base.set(boundary, "export {};\n");
    head.set(boundary, "export {};\n");

    expect(
      checkParserVersions({
        base,
        head,
        boundaries: [{ path: boundary, reason: "invalid test boundary" }],
      }),
    ).toContain(
      `Parser output boundary lies in an output-shaping root: ${boundary}`,
    );
  }
});

test("an output module also reachable without a boundary still needs a bump", () => {
  const base = fixture();
  const head = fixture();
  for (const tree of [base, head]) {
    tree.set(
      `${PARSERS}parser-a.ts`,
      [
        'import { logger } from "@/api/lib/observability/logger";',
        'import { helper } from "./shared-helper";',
        "export const parseA = () => { logger.info(); return helper(); };",
      ].join("\n"),
    );
    tree.set(
      LOGGER,
      [
        'import { helper } from "@/api/handlers/case-law/ingestion/parsers/shared-helper";',
        'import { hidden } from "../output-hidden-by-logger";',
        "export const logger = { info: () => helper() + hidden };",
      ].join("\n"),
    );
    tree.set(
      "apps/api/src/lib/output-hidden-by-logger.ts",
      "export const hidden = 'base';",
    );
  }
  head.set(
    `${PARSERS}shared-helper.ts`,
    "export const helper = () => 'changed';\n",
  );

  expect(changed(base, head)).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
    expect.stringContaining("test-b: parser version 1 must exceed base 1"),
  ]);

  head.set(
    `${PARSERS}shared-helper.ts`,
    "export const helper = () => 'base';\n",
  );
  head.set(
    "apps/api/src/lib/output-hidden-by-logger.ts",
    "export const hidden = 'changed';",
  );
  expect(changed(base, head)).toEqual([]);
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

  expect(changed(base, head)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("test-a: parser version 1 must exceed base 1"),
    ]),
  );
});

const deletedFacade = (facadeSource: string) => {
  const base = fixture();
  const facade = `${PARSERS}facade.ts`;
  const parser = `${PARSERS}parser-a.ts`;
  base.set(facade, facadeSource);
  base.set(
    parser,
    'import { helper } from "./facade";\nexport const parseA = () => helper();\n',
  );
  const head = new Map(base);
  head.delete(facade);
  head.set(
    parser,
    "// parser-output-unchanged: imports helper directly from its owner\n" +
      'import { helper } from "./shared-helper";\nexport const parseA = () => helper();\n',
  );
  return { base, head, facade, parser };
};

const movedHelper = ({
  changedOutput = false,
  keepCounterpart = true,
} = {}) => {
  const base = fixture({ adapters: ["A"] });
  const head = new Map(base);
  const original = `${PARSERS}shared-helper.ts`;
  const destination = `${PARSERS}moved-helper.ts`;
  head.delete(original);
  if (keepCounterpart) {
    head.set(
      destination,
      changedOutput
        ? "export const helper = () => 'changed';\n"
        : `${base.get(original) ?? ""}// parser-output-unchanged: file moved without output changes\n`,
    );
  }
  head.set(
    `${PARSERS}parser-a.ts`,
    [
      ...(keepCounterpart
        ? ["// parser-output-unchanged: helper moved without output changes"]
        : []),
      keepCounterpart
        ? 'import { helper } from "./moved-helper";'
        : "const helper = () => 'base';",
      "export const parseA = () => helper();",
    ].join("\n"),
  );
  return { base, head };
};

test("verbatim parser source moves do not require a version bump", () => {
  const { base, head } = movedHelper();
  expect(changed(base, head)).toEqual([]);
});

test("moving non-code assets does not enter parser-source move detection", () => {
  const base = fixture({ adapters: ["A"] });
  const head = new Map(base);
  const assets = new Map([
    [`${PARSERS}assets/manifest.json`, '{"schema":"v1"}\n'],
    [
      `${PARSERS}assets/frame.html`,
      '<!doctype html><html><head><meta charset="utf-8"></head></html>\n',
    ],
  ]);
  for (const [original, source] of assets) {
    const destination = original.replace("/assets/", "/assets-v2/");
    base.set(original, source);
    head.delete(original);
    head.set(destination, source);
  }

  expect(changed(base, head)).toEqual([]);
});

test("verbatim parser source moves require equivalent resolved dependencies", () => {
  const base = fixture({ adapters: ["A"] });
  const originalDirectory = `${PARSERS}original`;
  const destinationDirectory = `${PARSERS}destination`;
  const helperSource =
    'import { dependency } from "./dependency";\nexport const helper = () => dependency();\n';
  base.set(`${originalDirectory}/helper.ts`, helperSource);
  base.set(
    `${originalDirectory}/dependency.ts`,
    "export const dependency = () => 'base';\n",
  );
  base.set(
    `${destinationDirectory}/dependency.ts`,
    "export const dependency = () => 'different';\n",
  );
  base.set(
    `${PARSERS}parser-a.ts`,
    'import { helper } from "./original/helper";\nexport const parseA = () => helper();\n',
  );
  const head = new Map(base);
  head.delete(`${originalDirectory}/helper.ts`);
  head.set(`${destinationDirectory}/helper.ts`, helperSource);
  head.set(
    `${PARSERS}parser-a.ts`,
    '// parser-output-unchanged: helper moved\nimport { helper } from "./destination/helper";\nexport const parseA = () => helper();\n',
  );

  expect(changed(base, head)).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  ]);
});

test("verbatim moves of location-dependent parser sources still require a version bump", () => {
  const base = fixture({ adapters: ["A"] });
  const helperSource = "export const helper = () => import.meta.url;\n";
  base.set(`${PARSERS}original/helper.ts`, helperSource);
  base.set(
    `${PARSERS}parser-a.ts`,
    'import { helper } from "./original/helper";\nexport const parseA = () => helper();\n',
  );
  const head = new Map(base);
  head.delete(`${PARSERS}original/helper.ts`);
  head.set(`${PARSERS}destination/helper.ts`, helperSource);
  head.set(
    `${PARSERS}parser-a.ts`,
    '// parser-output-unchanged: helper moved\nimport { helper } from "./destination/helper";\nexport const parseA = () => helper();\n',
  );

  expect(changed(base, head)).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  ]);
});

test("verbatim moves that swap dependency bindings still require a version bump", () => {
  const base = fixture({ adapters: ["A"] });
  const helperSource =
    'import { value as a } from "./a";\nimport { value as b } from "./b";\nexport const helper = () => a() + b();\n';
  const aSource = "export const value = () => 'a';\n";
  const bSource = "export const value = () => 'b';\n";
  base.set(`${PARSERS}original/helper.ts`, helperSource);
  base.set(`${PARSERS}original/a.ts`, aSource);
  base.set(`${PARSERS}original/b.ts`, bSource);
  base.set(
    `${PARSERS}parser-a.ts`,
    'import { helper } from "./original/helper";\nexport const parseA = () => helper();\n',
  );
  const head = new Map(base);
  for (const name of ["helper", "a", "b"]) {
    head.delete(`${PARSERS}original/${name}.ts`);
  }
  head.set(`${PARSERS}destination/helper.ts`, helperSource);
  head.set(`${PARSERS}destination/a.ts`, bSource);
  head.set(`${PARSERS}destination/b.ts`, aSource);
  head.set(
    `${PARSERS}parser-a.ts`,
    '// parser-output-unchanged: helper moved\nimport { helper } from "./destination/helper";\nexport const parseA = () => helper();\n',
  );

  expect(changed(base, head)).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  ]);
});

test("a verbatim parser folder move preserves moved dependencies", () => {
  const base = fixture({ adapters: ["A"] });
  const head = new Map(base);
  const originalDirectory = `${PARSERS}original`;
  const destinationDirectory = `${PARSERS}destination`;
  const movedFiles = new Map([
    [
      "helper.ts",
      'import { dependency } from "./dependency";\nexport const helper = () => dependency();\n',
    ],
    ["dependency.ts", "export const dependency = () => 'base';\n"],
  ]);
  for (const [file, source] of movedFiles) {
    base.set(`${originalDirectory}/${file}`, source);
    head.set(`${destinationDirectory}/${file}`, source);
  }
  base.set(
    `${PARSERS}parser-a.ts`,
    'import { helper } from "./original/helper";\nexport const parseA = () => helper();\n',
  );
  head.delete(`${originalDirectory}/helper.ts`);
  head.delete(`${originalDirectory}/dependency.ts`);
  head.set(
    `${PARSERS}parser-a.ts`,
    '// parser-output-unchanged: helper folder moved\nimport { helper } from "./destination/helper";\nexport const parseA = () => helper();\n',
  );

  expect(changed(base, head)).toEqual([]);
});

test("parser source moves with logic changes still require a version bump", () => {
  const { base, head } = movedHelper({ changedOutput: true });
  expect(changed(base, head)).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  ]);
});

test("parser source deletions without a counterpart still require a version bump", () => {
  const { base, head } = movedHelper({ keepCounterpart: false });
  expect(changed(base, head)).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  ]);
});

const deletedWorkspaceDependency = (marker = "") => {
  const base = fixture({ adapters: ["A"] });
  const parser = `${PARSERS}parser-a.ts`;
  base.set(
    "packages/dependency/package.json",
    JSON.stringify({ exports: "./src/index.ts" }),
  );
  base.set(
    "packages/dependency/src/index.ts",
    "export const dependency = () => 'base';\n",
  );
  base.set(
    parser,
    'import { dependency } from "@stll/dependency";\nimport { helper } from "./shared-helper";\nexport const parseA = () => dependency() + helper();\n',
  );
  const head = new Map(base);
  head.delete("packages/dependency/package.json");
  head.delete("packages/dependency/src/index.ts");
  head.set(
    parser,
    `${marker}import { dependency } from "@stll/dependency";\nimport { helper } from "./shared-helper";\nexport const parseA = () => dependency() + helper();\n`,
  );
  return { base, head, parser };
};

test("an owner-level marker exempts a deleted parser dependency", () => {
  const { base, head } = deletedWorkspaceDependency(
    "// parser-output-unchanged: [test-a] dependency now resolves to the equivalent published package\n",
  );
  expect(changed(base, head)).toEqual([]);
});

test("a deleted parser dependency without an owner-level marker requires a version bump", () => {
  const { base, head } = deletedWorkspaceDependency();
  expect(changed(base, head)).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  ]);
});

test("an owner-level marker does not exempt another modified parser dependency", () => {
  const { base, head } = deletedWorkspaceDependency(
    "// parser-output-unchanged: [test-a] dependency now resolves to the equivalent published package\n",
  );
  head.set(
    `${PARSERS}shared-helper.ts`,
    "export const helper = () => 'changed';\n",
  );
  expect(changed(base, head)).toEqual([
    expect.stringContaining(`${PARSERS}shared-helper.ts`),
  ]);
});

test("an owner-level marker does not exempt another deleted parser dependency", () => {
  const marker =
    "// parser-output-unchanged: [test-a] dependency now resolves to the equivalent published package\n";
  const { base, head, parser } = deletedWorkspaceDependency(marker);
  head.delete(`${PARSERS}shared-helper.ts`);
  head.set(
    parser,
    `${marker}import { dependency } from "@stll/dependency";\nexport const parseA = () => dependency() + "base";\n`,
  );
  expect(changed(base, head)).toEqual([
    expect.stringContaining(`${PARSERS}shared-helper.ts`),
  ]);
});

test("an owner-level marker does not exempt a removed package the parser no longer imports", () => {
  const { base, head, parser } = deletedWorkspaceDependency();
  head.set(
    parser,
    '// parser-output-unchanged: [test-a] dependency now resolves to the equivalent published package\nimport { helper } from "./shared-helper";\nexport const parseA = () => helper();\n',
  );
  expect(changed(base, head)).toEqual([
    expect.stringContaining("packages/dependency/src/index.ts"),
  ]);
});

test("deleted modules containing only reexports need no parser version bump", () => {
  for (const source of [
    'export { helper } from "./shared-helper";\n',
    '// facade\nexport { helper as helper } from "./shared-helper";\n',
    '/* types too */\nexport type { Helper } from "./shared-helper";\nexport { helper } from "./shared-helper";\n',
    'export * from "./shared-helper";\n',
    'export type * from "./shared-helper";\nexport { helper } from "./shared-helper";\n',
    'export /* const local = 1 */ { helper } /* comment */ from "./shared-helper";\n',
    'export { type Helper, helper, } from "./shared-helper";\n',
    'export type { Helper as Renamed } from "./shared-helper";\nexport { helper } from "./shared-helper";\n',

    'export {\n helper,\n} from "./shared-helper"\n\n// trailing comment\n',
  ]) {
    const { base, head } = deletedFacade(source);
    expect(changed(base, head)).toEqual([]);
  }
});

test("deleted reexport modules with any local code still need a bump", () => {
  for (const localCode of [
    "export const local = 1;",
    "const local = 1;",
    "type Local = string;",
    "export type Local = string;",
    "declare const local: string;",
    "const unused = '/* export */';",
    "export default 1;",

    "interface Local { value: string }",
    'import "./shared-helper";',
    "export { helper };",
    'void "export * from ./shared-helper";',
  ]) {
    const { base, head, facade } = deletedFacade(
      `export { helper } from "./shared-helper";\n${localCode}\n`,
    );
    head.set(
      `${PARSERS}parser-a.ts`,
      'import { helper } from "./shared-helper";\nexport const parseA = () => helper();\n',
    );
    expect(changed(base, head)).toEqual([expect.stringContaining(facade)]);
  }
});

test("deleting a reexport module cannot exempt another unmarked parser change", () => {
  const { base, head, parser } = deletedFacade(
    'export { helper } from "./shared-helper";\n',
  );
  head.set(
    parser,
    'import { helper } from "./shared-helper";\nexport const parseA = () => helper();\n',
  );
  expect(changed(base, head)).toEqual([
    `test-a: parser version 1 must exceed base 1; changed: ${parser}`,
  ]);
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
  expect(changed(base, changedC)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("test-c: parser version 1 must exceed base 1"),
    ]),
  );
  expect(changed(base, bumpedC)).toEqual([]);
  expect(changed(base, fixture({ missingVersion: "A" }))).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "Registry entry ADAPTER_KEYS.A has no resolvable adapter or parser version",
      ),
    ]),
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
    `${head.get(adapter) ?? ""}\nexport const assemble = () => 'changed output';\n`,
  );
  expect(changed(base, head)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("test-a: parser version 1 must exceed base 1"),
    ]),
  );
});

test("unresolved repository dependencies fail closed", () => {
  const base = fixture();
  const head = fixture();
  head.set(
    `${PARSERS}parser-a.ts`,
    'import { missing } from "./missing-parser"; export const parseA = () => missing();',
  );
  expect(changed(base, head)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Unresolved repository import ./missing-parser"),
    ]),
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

test("versions an imported module declares for its own records do not count as the source's", () => {
  // Adapter A imports adapter B and a collection helper; each stamps its own
  // records with a version that differs from A's.
  const withImports = (tree: Map<string, string>) => {
    const adapterA = `${ADAPTERS}adapter-a.ts`;
    tree.set(
      adapterA,
      [
        'import { AdapterB } from "./adapter-b";',
        'import { enrich } from "./collections";',
        tree.get(adapterA),
      ].join("\n"),
    );
    tree.set(
      `${ADAPTERS}collections.ts`,
      [
        "export const COLLECTION_PARSER_VERSION = 9;",
        "export const enrich = () => ({ parserVersion: COLLECTION_PARSER_VERSION });",
      ].join("\n"),
    );
    return tree;
  };
  const parserSources = { A: "export const parseA = () => 'changed';\n" };
  const base = withImports(fixture({ versions: { B: 5 } }));

  expect(
    changed(
      base,
      withImports(fixture({ versions: { A: 2, B: 5 }, parserSources })),
    ),
  ).toEqual([]);
  expect(
    changed(base, withImports(fixture({ versions: { B: 5 }, parserSources }))),
  ).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
  ]);
});

const PDF_PATCH = "patches/pdf-reader@1.0.0.patch";

/** The fixture with `pdf-reader` patched and read by adapter A's parser only. */
const withPatchedReader = (
  tree: Map<string, string>,
  patch: string,
  manifestPatch = PDF_PATCH,
): Map<string, string> => {
  tree.set(
    "package.json",
    JSON.stringify({
      patchedDependencies: { "pdf-reader@1.0.0": manifestPatch },
    }),
  );
  tree.set(PDF_PATCH, patch);
  const parserA = `${PARSERS}parser-a.ts`;
  tree.set(
    parserA,
    ['import { read } from "pdf-reader";', tree.get(parserA), "read();"].join(
      "\n",
    ),
  );
  return tree;
};

test("a dependency patch change demands a bump of every parser importing the package", () => {
  const base = withPatchedReader(fixture(), "git-blob:old");

  expect(changed(base, withPatchedReader(fixture(), "git-blob:new"))).toEqual([
    "test-a: parser version 1 must exceed base 1; changed: patches/pdf-reader@1.0.0.patch (patches pdf-reader)",
  ]);
  expect(
    changed(
      base,
      withPatchedReader(fixture({ versions: { A: 2 } }), "git-blob:new"),
    ),
  ).toEqual([]);
  // A parser-output-unchanged marker cannot waive a patch.
  expect(
    changed(
      base,
      withPatchedReader(
        fixture({ markerSource: "// parser-output-unchanged: [test-a] no.\n" }),
        "git-blob:new",
      ),
    ),
  ).toEqual([expect.stringContaining("test-a: parser version 1 must exceed")]);
});

test("a patched dependency the tree does not hold fails closed", () => {
  const base = withPatchedReader(fixture(), "git-blob:old");

  expect(
    changed(
      base,
      withPatchedReader(fixture(), "git-blob:old", "patches/missing.patch"),
    ),
  ).toEqual([
    "package.json patchedDependencies entry pdf-reader@1.0.0 names no package and patch file the tree holds",
    // Unread, the patch counts as changed for the parser importing it.
    "test-a: parser version 1 must exceed base 1; changed: patches/pdf-reader@1.0.0.patch (patches pdf-reader)",
  ]);
});

test("a version an imported module stamps on its own records is checked like an adapter's", () => {
  const withCollections = (
    tree: Map<string, string>,
    {
      version = 9,
      body = "'base'",
      patch = "git-blob:old",
      name = "COLLECTION_PARSER_VERSION",
      duplicateName,
      consumer = "A",
    }: {
      version?: number;
      body?: string;
      patch?: string;
      name?: string;
      duplicateName?: string;
      consumer?: "A" | "B";
    } = {},
  ) => {
    for (const key of ["A", "B"] as const) {
      const adapter = `${ADAPTERS}adapter-${key.toLowerCase()}.ts`;
      const source = tree.get(adapter) ?? "";
      const withoutEnrichmentImport = source.replace(
        'import { enrich } from "./collections";\n',
        "",
      );
      tree.set(
        adapter,
        key === consumer
          ? `import { enrich } from "./collections";\n${withoutEnrichmentImport}`
          : withoutEnrichmentImport,
      );
    }
    tree.set(
      `${ADAPTERS}collections.ts`,
      [
        'import { read } from "pdf-reader";',
        `export const ${name} = ${version};`,
        `export const enrich = () => ({ parserVersion: ${name}, text: read(${body}) });`,
        ...(duplicateName === undefined
          ? []
          : [
              `export const ${duplicateName} = ${version};`,
              `export const enrichAgain = () => ({ parserVersion: ${duplicateName} });`,
            ]),
      ].join("\n"),
    );
    tree.set(
      "package.json",
      JSON.stringify({
        patchedDependencies: { "pdf-reader@1.0.0": PDF_PATCH },
      }),
    );
    tree.set(PDF_PATCH, patch);
    return tree;
  };
  const base = withCollections(fixture());
  const record =
    "COLLECTION_PARSER_VERSION in apps/api/src/handlers/case-law/ingestion/adapters/collections.ts";

  // The enrichment's own reading changed: its record version and the
  // importing adapter's both move.
  expect(
    changed(base, withCollections(fixture(), { body: "'changed'" })),
  ).toEqual([
    expect.stringContaining("test-a: parser version 1 must exceed base 1"),
    `${record}: parser version 9 must exceed base 9; changed: apps/api/src/handlers/case-law/ingestion/adapters/collections.ts`,
  ]);
  expect(
    changed(
      base,
      withCollections(fixture({ versions: { A: 2 } }), {
        body: "'changed'",
        version: 10,
      }),
    ),
  ).toEqual([]);
  // The package it reads with was patched.
  expect(
    changed(
      base,
      withCollections(fixture({ versions: { A: 2 } }), {
        patch: "git-blob:new",
      }),
    ),
  ).toEqual([
    `${record}: parser version 9 must exceed base 9; changed: patches/pdf-reader@1.0.0.patch (patches pdf-reader)`,
  ]);
  expect(changed(base, withCollections(fixture(), { version: 8 }))).toEqual([
    `${record}: parser version 8 must not be lower than base 9`,
  ]);

  // Renaming the declaration keeps the same stream identity. A parser bump
  // cannot waive the record version's independent output change.
  expect(
    changed(
      base,
      withCollections(fixture({ versions: { A: 2 } }), {
        body: "'changed'",
        name: "COLLECTION_OUTPUT_VERSION",
      }),
    ),
  ).toEqual([
    expect.stringContaining(
      "COLLECTION_OUTPUT_VERSION in apps/api/src/handlers/case-law/ingestion/adapters/collections.ts: parser version 9 must exceed base 9",
    ),
  ]);
  expect(
    changed(
      base,
      withCollections(fixture({ versions: { A: 2 } }), {
        body: "'changed'",
        name: "COLLECTION_OUTPUT_VERSION",
        version: 10,
      }),
    ),
  ).toEqual([]);

  // Moving the stamp to another consumer creates a different identity; the
  // missing base stream must be reported even when both parser owners bump.
  expect(
    changed(
      base,
      withCollections(fixture({ versions: { A: 2, B: 2 } }), {
        consumer: "B",
      }),
    ),
  ).toEqual([
    expect.stringContaining(
      "COLLECTION_PARSER_VERSION in apps/api/src/handlers/case-law/ingestion/adapters/collections.ts disappeared or changed its stamped-in modules",
    ),
  ]);
  expect(
    changed(
      base,
      withCollections(fixture(), {
        duplicateName: "COLLECTION_CACHE_VERSION",
      }),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "Record version stream in apps/api/src/handlers/case-law/ingestion/adapters/collections.ts stamped by apps/api/src/handlers/case-law/ingestion/adapters/adapter-a.ts has multiple declarations",
      ),
    ]),
  );
});

test("the queue compares against its exact base while pull requests use the merge-base", () => {
  const commands: string[][] = [];
  const runGit = (args: string[]) => {
    commands.push(args);
    const ok = (output: string) =>
      ({ type: "ok", output: new TextEncoder().encode(output) }) as const;
    // "pr-merge" is GitHub's test merge of "pr-head"; "branch-merge" is a
    // branch head that merged main into itself; "pr-head" is no merge.
    if (args.includes("pr-head^2")) {
      return { type: "failed", detail: "not a merge" } as const;
    }
    if (args.includes("pr-merge^2")) {
      return ok("pr-head");
    }
    if (args.includes("branch-merge^2")) {
      return ok("main-tip");
    }
    return ok(args.at(0) === "rev-parse" ? "queue-base" : "fork-base");
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
    pullRequestHead: "pr-head",
    runGit,
  });
  // A stale event base must not pull later base commits into the comparison.
  const mergedPullRequest = comparisonBase({
    event: "pull_request",
    base: "stale-main",
    head: "pr-merge",
    pullRequestHead: "pr-head",
    runGit,
  });
  const branchMerge = comparisonBase({
    event: "pull_request",
    base: "main-head",
    head: "branch-merge",
    pullRequestHead: "branch-merge",
    runGit,
  });
  expect(commands).toEqual([
    ["rev-parse", "--verify", "queue-base^{commit}"],
    ["rev-parse", "--verify", "--quiet", "pr-head^2"],
    ["merge-base", "main-head", "pr-head"],
    ["rev-parse", "--verify", "--quiet", "pr-merge^2"],
    ["merge-base", "--is-ancestor", "stale-main", "pr-merge^1"],
    ["rev-parse", "--verify", "pr-merge^1^{commit}"],
    ["rev-parse", "--verify", "--quiet", "branch-merge^2"],
    ["merge-base", "main-head", "branch-merge"],
  ]);
  expect(queue.type).toBe("ok");
  expect(pullRequest.type).toBe("ok");
  expect(mergedPullRequest.type).toBe("ok");
  expect(branchMerge.type).toBe("ok");
  // Both PRs pass at their fork point; the second fails after the first bump
  // becomes the queue base, so it cannot publish another change at version 2.
  const second = fixture({
    versions: { A: 2 },
    parserSources: { A: "export const parseA = () => 'second fix';" },
  });
  expect(changed(fixture(), second)).toEqual([]);
  expect(changed(fixture({ versions: { A: 2 } }), second)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("test-a: parser version 2 must exceed base 2"),
    ]),
  );
  expect(
    comparisonBase({
      event: "merge_group",
      base: "",
      head: "queue-head",
      runGit,
    }).type,
  ).toBe("failed");
  expect(commands).toHaveLength(8);
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
  expect(changed(base, head)).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "Unresolved repository import @stll/docx-core/model",
      ),
    ]),
  );
});

test("a blobless clone fetches every missing source blob in one round trip", () => {
  const root = mkdtempSync(path.join(tmpdir(), "parser-guard-blobless-"));
  try {
    const run = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=guard",
          "-c",
          "user.email=guard@example.com",
          ...args,
        ],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      expect(
        result.exitCode,
        `${args.join(" ")}: ${result.stderr.toString()}`,
      ).toBe(0);
      return result.stdout.toString().trim();
    };
    const source = path.join(root, "source");
    const clone = path.join(root, "clone");
    const files = Array.from(
      { length: 20 },
      (_, index) => `apps/api/src/module-${String(index)}.ts`,
    );
    run(root, "init", "-q", "-b", "main", source);
    run(source, "config", "uploadpack.allowFilter", "true");
    run(source, "config", "uploadpack.allowAnySHA1InWant", "true");
    mkdirSync(path.join(source, "apps/api/src"), { recursive: true });
    const commit = (label: string) => {
      for (const file of files) {
        writeFileSync(
          path.join(source, file),
          `export const value = "${label}:${file}";\n`,
        );
      }
      run(source, "add", "-A");
      run(source, "commit", "-q", "-m", label);
      return run(source, "rev-parse", "HEAD");
    };
    const base = commit("base");
    commit("head");
    // Reachability bitmaps make the server, like GitHub, skip objects reachable
    // from commits the client negotiates as present, including missing blobs.
    run(source, "repack", "-a", "-d", "-b", "-q");
    run(root, "clone", "-q", "--filter=blob:none", `file://${source}`, clone);

    // Count the server round trips the clone makes from here on.
    const log = path.join(root, "upload-pack.log");
    const wrapper = path.join(root, "upload-pack.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho fetch >> "${log}"\nexec git upload-pack "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(log, "");
    run(clone, "config", "remote.origin.uploadpack", wrapper);
    const baseBlob = run(clone, "rev-parse", `${base}:${files.at(0) ?? ""}`);
    expect(
      Bun.spawnSync(["git", "--no-lazy-fetch", "cat-file", "-e", baseBlob], {
        cwd: clone,
      }).exitCode,
    ).not.toBe(0);

    const tree = readGitTree(base, { repository: clone });

    expect(tree.type).toBe("ok");
    const read = tree.type === "ok" ? tree.files : new Map<string, string>();
    for (const file of files) {
      expect(read.get(file)).toBe(`export const value = "base:${file}";\n`);
    }
    expect(readFileSync(log, "utf-8").trim().split("\n")).toEqual(["fetch"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("trees without decoded source retain empty and non-code identities", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "parser-guard-empty-"));
  try {
    const run = (...args: string[]) => {
      const result = Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=guard",
          "-c",
          "user.email=guard@example.com",
          ...args,
        ],
        { cwd: repository, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    run("init", "-q");
    run("commit", "-q", "--allow-empty", "-m", "empty");
    const empty = readGitTree("HEAD", { repository });
    expect(empty.type).toBe("ok");
    if (empty.type === "ok") {
      expect([...empty.files]).toEqual([]);
    }

    const file = "apps/api/src/fixture.wasm";
    mkdirSync(path.join(repository, "apps/api/src"), { recursive: true });
    writeFileSync(path.join(repository, file), "opaque fixture");
    run("add", file);
    run("commit", "-q", "-m", "non-code");
    const identity = `git-blob:${run("rev-parse", `HEAD:${file}`)}`;
    const nonCode = readGitTree("HEAD", { repository });
    expect(nonCode.type).toBe("ok");
    if (nonCode.type === "ok") {
      expect([...nonCode.files]).toEqual([[file, identity]]);
    }
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});
