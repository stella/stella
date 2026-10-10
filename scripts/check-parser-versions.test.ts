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
      "// parser-output-unchanged: helper moved without output changes",
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
    expect(changed(base, head)).toEqual([
      `test-a: parser version 1 must exceed base 1; changed: ${facade}`,
    ]);
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
