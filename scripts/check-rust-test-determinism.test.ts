import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  discoverRustTestFiles,
  evaluateRustTestBaseline,
  RUST_TEST_DISCOVERY_INPUTS,
} from "./check-rust-test-determinism.ts";
import { parseTestBaseline } from "./check-test-state-baseline.ts";
import { planCheck, PLUGIN_FIXTURE_INPUTS } from "./code-check-affected.ts";
import { scanRustTestDeterminism } from "./rust-test-determinism-scan.ts";

const patterns = [
  ["std::thread::sleep(duration);", "sleep"],
  ["thread::sleep(duration);", "sleep"],
  ["tokio::time::sleep(duration).await;", "sleep"],
  ["let start = Instant::now();", "clock"],
  ["let start = std::time::Instant::now();", "clock"],
  ["let start = SystemTime::now();", "clock"],
  ["let start = std::time::SystemTime::now();", "clock"],
  ['let child = Command::new("worker");', "process"],
  ['let child = std::process::Command::new("worker");', "process"],
] as const;

const scopes = [
  [
    "whole-file inner cfg(test)",
    (body: string) => `#![cfg(test)] fn helper() { ${body} }`,
    false,
  ],
  [
    "cfg(test) module",
    (body: string) => `#[cfg(test)] mod tests { fn helper() { ${body} } }`,
    false,
  ],
  [
    "cfg(test) impl",
    (body: string) => `#[cfg(test)] impl Helper { fn helper() { ${body} } }`,
    false,
  ],
  [
    "test function",
    (body: string) => `#[test] fn example() { ${body} }`,
    false,
  ],
  [
    "tokio test function",
    (body: string) => `#[tokio::test] async fn example() { ${body} }`,
    false,
  ],
  [
    "configured tokio test function",
    (body: string) =>
      `#[tokio::test(flavor = "multi_thread")] async fn example() { ${body} }`,
    false,
  ],
  ["integration test file", (body: string) => `fn helper() { ${body} }`, true],
] as const;

for (const [scope, wrap, integrationTest] of scopes) {
  test.each(patterns)(`counts %s in ${scope}`, (body, kind) => {
    expect(
      scanRustTestDeterminism({ source: wrap(body), integrationTest }),
    ).toEqual([{ line: 1, kind, escaped: false }]);
  });
}

test.each(patterns)("excludes %s in production code", (body) => {
  const source = `fn production() { ${body} }\n#[test] fn unrelated() { assert!(true); }`;
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual(
    [],
  );
});

test.each(["Mutex", "RwLock", "OnceLock"])(
  "counts access to a process-global static %s only inside test code",
  (lock) => {
    const initializer = lock === "OnceLock" ? "new()" : "new(0)";
    const declaration = `static SHARED: std::sync::${lock}<u32> = std::sync::${lock}::${initializer};`;
    const source = `${declaration}\nfn production() { let value = &SHARED; }\n#[test] fn example() { let value = &SHARED; }`;
    expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual(
      [{ line: 3, kind: "global-lock", escaped: false }],
    );
    expect(
      scanRustTestDeterminism({ source: declaration, integrationTest: true }),
    ).toEqual([]);
  },
);

test("does not count local synchronization values as process-global state", () => {
  const source =
    "#[test] fn example() { let local = Mutex::new(0); local.lock(); }";
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual(
    [],
  );
});

test("ignores nested comments, ordinary and raw strings, byte strings and characters", () => {
  const source = `#[test] fn example() {
  // thread::sleep(duration); Instant::now();
  /* outer /* tokio::time::sleep(duration); */ Command::new("worker"); */
  let ordinary = "SystemTime::now(); \\" thread::sleep(duration);";
  let raw = r###"Instant::now(); "# Command::new("worker");"###;
  let bytes = b"thread::sleep(duration);";
  let raw_bytes = br#"SystemTime::now();"#;
  let brace = '}'; let quote = '\\''; let byte = b'{';
  thread::sleep(duration);
}`;
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual([
    { line: 9, kind: "sleep", escaped: false },
  ]);
});

test("lifetimes and labels do not hide subsequent test code", () => {
  const source = `#[test] fn example<'a>() {
  'outer: loop { let value: &'a str = "value"; break 'outer; }
  Instant::now();
}`;
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual([
    { line: 3, kind: "clock", escaped: false },
  ]);
});

test("test attributes inside strings and comments cannot turn production code into tests", () => {
  const source = `// #[test]
fn production() { Instant::now(); }
const EXAMPLE: &str = "#[cfg(test)] mod tests {";
fn second() { thread::sleep(duration); }`;
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual(
    [],
  );
});

test("a wrong fixture crosses the detector boundary before its expected result is used", () => {
  const production = 'fn example() { Command::new("worker"); }';
  const fixture = `#[test] ${production}`;
  const wrongFixtureHits = scanRustTestDeterminism({
    source: production,
    integrationTest: false,
  });
  const fixtureHits = scanRustTestDeterminism({
    source: fixture,
    integrationTest: false,
  });
  expect(wrongFixtureHits).toEqual([]);
  expect(fixtureHits).toEqual([{ line: 1, kind: "process", escaped: false }]);
  expect(fixtureHits).not.toEqual(wrongFixtureHits);
});

test("reasoned escapes remain counted and record same-line or preceding-line ownership", () => {
  const source = `#[test] fn example() {
  thread::sleep(duration); // kit-allow: exercise deadline boundary
  // kit-allow: exercise wall clock conversion
  SystemTime::now();
  Instant::now(); // kit-allow:
  let text = "// kit-allow: not a comment"; Command::new("worker");
  /* kit-allow: not a line comment */ thread::sleep(duration);
}`;
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual([
    { line: 2, kind: "sleep", escaped: true },
    { line: 4, kind: "clock", escaped: true },
    { line: 5, kind: "clock", escaped: false },
    { line: 6, kind: "process", escaped: false },
    { line: 7, kind: "sleep", escaped: false },
  ]);
});

const FILE = "crates/example/src/lib.rs";
const metadata = { owner: "guards", reason: "Replace legacy nondeterminism" };
const hits = scanRustTestDeterminism({
  source: "#[test] fn example() { Instant::now(); thread::sleep(duration); }",
  integrationTest: false,
});

test("baseline counts accept exact budgets and reject growth, shrinkage and stale files", () => {
  expect(hits).toHaveLength(2);
  const files = new Map([[FILE, hits]]);
  const evaluate = (count: number) =>
    evaluateRustTestBaseline({
      files,
      baselineText: JSON.stringify({ [FILE]: { ...metadata, count } }),
    });
  expect(evaluate(2)).toEqual([]);
  expect(evaluate(1)).toEqual([
    expect.objectContaining({
      file: FILE,
      line: 1,
      message: expect.stringContaining("Rust test sleep:"),
    }),
  ]);
  expect(evaluate(3)).toEqual([
    expect.objectContaining({
      file: FILE,
      line: 1,
      message: expect.stringContaining("count 2 is below baseline 3"),
    }),
  ]);
  expect(
    evaluateRustTestBaseline({
      files: new Map(),
      baselineText: JSON.stringify({ [FILE]: { ...metadata, count: 2 } }),
    }),
  ).toEqual([
    expect.objectContaining({
      file: FILE,
      line: 1,
      message: expect.stringContaining("count 0 is below baseline 2"),
    }),
  ]);
  expect(evaluateRustTestBaseline({ files, baselineText: "{}" })).not.toEqual(
    [],
  );
});

test("escaped occurrences consume their per-file baseline budget", () => {
  const escapedHits = scanRustTestDeterminism({
    source:
      "#[test] fn example() { Instant::now(); } // kit-allow: exercise deadline",
    integrationTest: false,
  });
  expect(escapedHits).toEqual([{ line: 1, kind: "clock", escaped: true }]);
  expect(
    evaluateRustTestBaseline({
      files: new Map([[FILE, escapedHits]]),
      baselineText: "{}",
    }),
  ).toEqual([
    expect.objectContaining({
      file: FILE,
      line: 1,
      message: expect.stringContaining(
        "Escaped occurrences still need a baseline slot",
      ),
    }),
  ]);
  expect(
    evaluateRustTestBaseline({
      files: new Map([[FILE, escapedHits]]),
      baselineText: JSON.stringify({ [FILE]: { ...metadata, count: 1 } }),
    }),
  ).toEqual([]);
  const mixedHits = scanRustTestDeterminism({
    source:
      "#[test] fn example() {\n Instant::now(); // kit-allow: exercise deadline\n\n thread::sleep(duration);\n}",
    integrationTest: false,
  });
  expect(mixedHits).toEqual([
    { line: 2, kind: "clock", escaped: true },
    { line: 4, kind: "sleep", escaped: false },
  ]);
  expect(
    evaluateRustTestBaseline({
      files: new Map([[FILE, mixedHits]]),
      baselineText: JSON.stringify({ [FILE]: { ...metadata, count: 1 } }),
    }),
  ).toEqual([expect.objectContaining({ file: FILE, line: 4 })]);
});

test.each([
  ["escaped before plain", [true, false], 4],
  ["plain before escaped", [false, true], 2],
] as const)(
  "reports the plain excess hit with %s",
  (_name, escapes, expectedLine) => {
    const source = [
      "#[test] fn example() {",
      ...escapes.flatMap((escaped) => [
        `  Instant::now();${escaped ? " // kit-allow: exercise deadline" : ""}`,
        "",
      ]),
      "}",
    ].join("\n");
    const orderedHits = scanRustTestDeterminism({
      source,
      integrationTest: false,
    });
    expect(orderedHits.map(({ escaped }) => escaped)).toEqual([...escapes]);
    expect(
      evaluateRustTestBaseline({
        files: new Map([[FILE, orderedHits]]),
        baselineText: JSON.stringify({ [FILE]: { ...metadata, count: 1 } }),
      }),
    ).toEqual([
      expect.objectContaining({
        file: FILE,
        line: expectedLine,
        message: expect.stringContaining("Rust test clock:"),
      }),
    ]);
  },
);

test("plain hits use excess slots before escaped hits regardless of source order", () => {
  const mixedHits = scanRustTestDeterminism({
    source:
      "#[test] fn example() {\n Instant::now(); // kit-allow: exercise deadline\n\n SystemTime::now();\n thread::sleep(duration); // kit-allow: exercise timer\n}",
    integrationTest: false,
  });
  expect(mixedHits.map(({ escaped }) => escaped)).toEqual([true, false, true]);
  expect(
    evaluateRustTestBaseline({
      files: new Map([[FILE, mixedHits]]),
      baselineText: JSON.stringify({ [FILE]: { ...metadata, count: 1 } }),
    }),
  ).toEqual([
    expect.objectContaining({
      file: FILE,
      line: 4,
      message: expect.stringContaining("Rust test clock:"),
    }),
    expect.objectContaining({
      file: FILE,
      line: 5,
      message: expect.stringContaining(
        "Escaped occurrences still need a baseline slot",
      ),
    }),
  ]);
});

test("all escaped hits still report exactly their excess count", () => {
  const escapedHits = scanRustTestDeterminism({
    source:
      "#[test] fn example() {\n Instant::now(); // kit-allow: exercise deadline\n SystemTime::now(); // kit-allow: exercise wall clock\n thread::sleep(duration); // kit-allow: exercise timer\n}",
    integrationTest: false,
  });
  expect(escapedHits.map(({ escaped }) => escaped)).toEqual([true, true, true]);
  const diagnostics = evaluateRustTestBaseline({
    files: new Map([[FILE, escapedHits]]),
    baselineText: JSON.stringify({ [FILE]: { ...metadata, count: 1 } }),
  });
  expect(diagnostics).toEqual([
    expect.objectContaining({
      file: FILE,
      line: 3,
      message: expect.stringContaining(
        "Escaped occurrences still need a baseline slot",
      ),
    }),
    expect.objectContaining({
      file: FILE,
      line: 4,
      message: expect.stringContaining(
        "Escaped occurrences still need a baseline slot",
      ),
    }),
  ]);
});

test("escaped hits exactly within budget produce no diagnostics", () => {
  const escapedHits = scanRustTestDeterminism({
    source:
      "#[test] fn example() {\n Instant::now(); // kit-allow: exercise deadline\n SystemTime::now(); // kit-allow: exercise wall clock\n}",
    integrationTest: false,
  });
  expect(escapedHits).toHaveLength(2);
  expect(escapedHits.every(({ escaped }) => escaped)).toBe(true);
  expect(
    evaluateRustTestBaseline({
      files: new Map([[FILE, escapedHits]]),
      baselineText: JSON.stringify({ [FILE]: { ...metadata, count: 2 } }),
    }),
  ).toEqual([]);
});

test("all plain excess hits retain the latest source-line policy", () => {
  const plainHits = scanRustTestDeterminism({
    source:
      "#[test] fn example() {\n Instant::now();\n SystemTime::now();\n thread::sleep(duration);\n}",
    integrationTest: false,
  });
  expect(
    evaluateRustTestBaseline({
      files: new Map([[FILE, plainHits]]),
      baselineText: JSON.stringify({ [FILE]: { ...metadata, count: 1 } }),
    }),
  ).toEqual([
    expect.objectContaining({ file: FILE, line: 3 }),
    expect.objectContaining({ file: FILE, line: 4 }),
  ]);
});

test("enumeration discovers newly added crates and assigns files to their nearest manifest", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "rust-test-discovery-"));
  const sources = {
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]',
    "crates/new-engine/Cargo.toml":
      '[package]\nname = "new-engine"\nversion = "0.1.0"',
    "crates/new-engine/src/lib.rs":
      "#[cfg(test)] mod tests { #[test] fn example() {} }\n#[cfg(test)] mod support;\n#[cfg(test)] mod outer { mod helper; }",
    "crates/new-engine/src/outer/helper.rs": "fn helper() { Instant::now(); }",
    "crates/new-engine/src/support.rs":
      "fn helper() { Instant::now(); }\nmod nested;",
    "crates/new-engine/src/support/nested.rs":
      "fn helper() { SystemTime::now(); }",
    "crates/new-engine/src/production.rs":
      "fn production() { Instant::now(); }",
    "crates/new-engine/tests/integration.rs": "fn helper() { Instant::now(); }",
    "crates/new-engine/tests/support/helper.rs": "fn helper() {}",
    "crates/new-engine/nested/Cargo.toml":
      '[package]\nname = "nested"\nversion = "0.1.0"',
    "crates/new-engine/nested/src/lib.rs":
      "#[tokio::test] async fn example() {}",
    "unowned/tests/orphan.rs": "#[test] fn example() {}",
  };
  try {
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
      writeFileSync(path.join(repoRoot, file), source);
    }
    const files = discoverRustTestFiles(repoRoot, Object.keys(sources));
    expect(files).toEqual([
      {
        file: "crates/new-engine/nested/src/lib.rs",
        crate: "crates/new-engine/nested",
        integrationTest: false,
      },
      {
        file: "crates/new-engine/src/lib.rs",
        crate: "crates/new-engine",
        integrationTest: false,
      },
      {
        file: "crates/new-engine/src/outer/helper.rs",
        crate: "crates/new-engine",
        integrationTest: true,
      },
      {
        file: "crates/new-engine/src/production.rs",
        crate: "crates/new-engine",
        integrationTest: false,
      },
      {
        file: "crates/new-engine/src/support.rs",
        crate: "crates/new-engine",
        integrationTest: true,
      },
      {
        file: "crates/new-engine/src/support/nested.rs",
        crate: "crates/new-engine",
        integrationTest: true,
      },
      {
        file: "crates/new-engine/tests/integration.rs",
        crate: "crates/new-engine",
        integrationTest: true,
      },
      {
        file: "crates/new-engine/tests/support/helper.rs",
        crate: "crates/new-engine",
        integrationTest: true,
      },
    ]);
    expect(
      discoverRustTestFiles(repoRoot, Object.keys(sources).toReversed()),
    ).toEqual(files);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test.each([
  "/absolute.rs",
  "../outside.rs",
  "crates/./lib.rs",
  "crates//lib.rs",
  "crates\\lib.rs",
  "C:/lib.rs",
  "crates/lib.rs/",
  "crates/lib.txt",
])("rejects invalid Rust baseline repository path %s", (file) => {
  expect(() =>
    parseTestBaseline(
      JSON.stringify({ [file]: { ...metadata, count: 1 } }),
      "baseline",
    ),
  ).toThrow("must be a repository-relative test filename");
});

test.each([
  ["count", { ...metadata, count: 0 }],
  ["count", { ...metadata, count: 1.5 }],
  ["count", { ...metadata, count: Number.MAX_SAFE_INTEGER + 1 }],
  ["count", metadata],
  ["owner", { ...metadata, count: 1, owner: " " }],
  ["reason", { ...metadata, count: 1, reason: " " }],
] as const)(
  "Rust entries share baseline %s metadata validation",
  (field, entry) => {
    expect(() =>
      parseTestBaseline(JSON.stringify({ [FILE]: entry }), "baseline"),
    ).toThrow(`${FILE} ${field}`);
  },
);

test("Rust baseline parser expands each count into stable occurrence membership", () => {
  expect(
    parseTestBaseline(
      JSON.stringify({ [FILE]: { ...metadata, count: 2 } }),
      "baseline",
    ),
  ).toEqual([`${FILE}::1`, `${FILE}::2`]);
});

test("test scope ends at its matching brace despite nested blocks and string braces", () => {
  const source = `#[test] fn example() {
  if true { let value = "}"; Instant::now(); }
}
fn production() { SystemTime::now(); }
#[cfg(test)] mod tests { mod nested { fn helper() { thread::sleep(duration); } } }
fn second_production() { Command::new("worker"); }`;
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual([
    { line: 2, kind: "clock", escaped: false },
    { line: 5, kind: "sleep", escaped: false },
  ]);
});

test("test markers inside non-test conditional attributes do not activate scope", () => {
  const source = `#[cfg(not(test))] fn production() { Instant::now(); }
#[cfg(feature = "test")] fn feature_only() { thread::sleep(duration); }`;
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual(
    [],
  );
});

test.each([
  "crates/new-engine/src/lib.rs",
  "crates/new-engine/Cargo.toml",
  "scripts/rust-test-determinism-baseline.json",
  "scripts/rust-test-determinism-scan.ts",
  "scripts/check-rust-test-determinism.ts",
])("selects the baseline runner when %s changes or is deleted", (file) => {
  for (const presentChangedPaths of [[file], []]) {
    const planned = planCheck({
      changedPaths: [file],
      presentChangedPaths,
      repositoryPaths: presentChangedPaths,
      affectedWorkspacePaths: [],
      workspacePaths: new Set(),
      pluginModulePaths: new Set(),
    });
    expect(planned.type).toBe("scoped");
    if (planned.type !== "scoped") {
      return;
    }
    expect(planned.rootChecks).toContain("plugin-fixtures");
  }
});

test.each([
  "lib.rs",
  "crates/new-engine/src/lib.rs",
  "Cargo.toml",
  "crates/new-engine/Cargo.toml",
  "scripts/rust-test-determinism-baseline.json",
])("baseline runner cache inputs cover changed or deleted %s", (file) => {
  expect(
    PLUGIN_FIXTURE_INPUTS.some((input) =>
      new Bun.Glob(input.replace("$TURBO_ROOT$/", "")).match(file),
    ),
  ).toBe(true);
});

test("discovery and runner cache inputs share the Rust file enumeration", () => {
  for (const pattern of Object.values(RUST_TEST_DISCOVERY_INPUTS)) {
    expect(PLUGIN_FIXTURE_INPUTS).toContain(`$TURBO_ROOT$/${pattern}`);
  }
});

test("baseline runner selection inputs include scanner and baseline owners", () => {
  expect(PLUGIN_FIXTURE_INPUTS).toEqual(
    expect.arrayContaining([
      "$TURBO_ROOT$/scripts/rust-test-determinism-baseline.json",
      "$TURBO_ROOT$/scripts/rust-test-determinism-scan.ts",
      "$TURBO_ROOT$/scripts/check-rust-test-determinism.ts",
    ]),
  );
});

test("leading comments and other inner attributes preserve whole-file test scope", () => {
  const source = `// File documentation: #[cfg(test)]
/* outer /* nested */ comment */
#![allow(dead_code)]
#![doc = stringify!([ignored])]
// Another leading comment
#![cfg(test)]
fn helper() { Instant::now(); }`;
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual([
    { line: 7, kind: "clock", escaped: false },
  ]);
});

test.each([
  "fn earlier() {}\n#![cfg(test)]\nfn production() { Instant::now(); }",
  "mod nested { #![cfg(test)] fn helper() {} }\nfn production() { Instant::now(); }",
  '#![doc = "#![cfg(test)]"]\nfn production() { Instant::now(); }',
  "// #![cfg(test)]\nfn production() { Instant::now(); }",
])(
  "nonleading or inactive inner test markers do not activate whole-file scope: %s",
  (source) => {
    expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual(
      [],
    );
  },
);

test("whole-file inner test scope discovers an isolated crate and propagates to external modules", () => {
  const repoRoot = mkdtempSync(
    path.join(tmpdir(), "rust-inner-test-discovery-"),
  );
  const crate = "crates/inner-test";
  const helper = `${crate}/src/helper.rs`;
  const nested = `${crate}/src/helper/nested.rs`;
  const sources = {
    [`${crate}/Cargo.toml`]:
      '[package]\nname = "inner-test"\nversion = "0.1.0"',
    [`${crate}/src/lib.rs`]: "mod helper;",
    [helper]: "#![cfg(test)]\nmod nested;\nfn helper() { Instant::now(); }",
    [nested]: "fn helper() { SystemTime::now(); }",
  };
  try {
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
      writeFileSync(path.join(repoRoot, file), source);
    }
    const files = discoverRustTestFiles(repoRoot, Object.keys(sources));
    expect(files).toEqual([
      { file: helper, crate, integrationTest: false },
      { file: nested, crate, integrationTest: true },
      { file: `${crate}/src/lib.rs`, crate, integrationTest: false },
    ]);
    for (const { file, integrationTest } of files) {
      if (file === helper) {
        expect(
          scanRustTestDeterminism({ source: sources[helper], integrationTest }),
        ).toEqual([{ line: 3, kind: "clock", escaped: false }]);
      }
      if (file === nested) {
        expect(
          scanRustTestDeterminism({ source: sources[nested], integrationTest }),
        ).toEqual([{ line: 1, kind: "clock", escaped: false }]);
      }
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test.each([
  ["array return", "fn helper() -> [u8; 1]", "[0]"],
  ["left-shift array length", "fn helper() -> [u8; 1 << 2]", "[0; 4]"],
  ["right-shift array length", "fn helper() -> [u8; 8 >> 1]", "[0; 4]"],
  [
    "nested shifted array lengths",
    "fn helper() -> [[u8; 1 << 2]; 8 >> 1]",
    "[[0; 4]; 4]",
  ],
  [
    "generic shifted array length",
    "fn helper() -> Result<[u8; 1 << 2], &'static str>",
    "Ok([0; 4])",
  ],
  [
    "braced shifted const argument",
    "fn helper() -> Option<Buffer<{ 8 >> 1 }>>",
    "None",
  ],
  ["nested array return", "fn helper() -> [[u8; 1]; 2]", "[[0], [0]]"],
  ["function type argument", "fn helper() -> Option<fn() -> [u8; 1]>", "None"],
  ["braced array length", "fn helper() -> [u8; { (1 < 2) as usize }]", "[0]"],
  [
    "generic array return",
    "fn helper() -> Result<[u8; 1], &'static str>",
    "Ok([0])",
  ],
  [
    "array parameter and return",
    "fn helper(value: [u8; 1]) -> [u8; 1]",
    "value",
  ],
])(
  "counts test helper bodies after a %s header",
  (_name, signature, result) => {
    const source = `#[cfg(test)] ${signature} {
  thread::sleep(duration);
  ${result}
}
fn production() { Instant::now(); }`;
    expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual(
      [{ line: 2, kind: "sleep", escaped: false }],
    );
  },
);

test("masked string and character delimiters cannot truncate an array-returning test helper", () => {
  const source = `#[cfg(test)] fn helper() -> [u8; ";}".len()] {
  let brace = '}';
  let example = "thread::sleep(duration); };";
  thread::sleep(duration);
  [0; 2]
}
fn production() { SystemTime::now(); }`;
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual([
    { line: 4, kind: "sleep", escaped: false },
  ]);
});

test.each([
  ["automatic binary", "src/bin/worker.rs", "", false],
  ["automatic directory binary", "src/bin/worker/main.rs", "", false],
  [
    "custom library",
    "custom/worker.rs",
    '[lib]\npath = "custom/worker.rs"',
    false,
  ],
  [
    "custom binary",
    "custom/worker.rs",
    '[[bin]]\nname = "worker"\npath = "custom/worker.rs"',
    false,
  ],
  [
    "custom integration test",
    "custom/worker.rs",
    '[[test]]\nname = "worker"\npath = "custom/worker.rs"',
    true,
  ],
  [
    "custom benchmark",
    "custom/worker.rs",
    '[[bench]]\nname = "worker"\npath = "custom/worker.rs"',
    false,
  ],
  [
    "custom example",
    "custom/worker.rs",
    '[[example]]\nname = "worker"\npath = "custom/worker.rs"',
    false,
  ],
] as const)(
  "resolves test modules beside the %s target root",
  (_name, rootPath, targetManifest, wholeFileTest) => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "rust-target-discovery-"));
    const crate = "crates/target-root";
    const rootFile = `${crate}/${rootPath}`;
    const sibling = `${crate}/${path.posix.dirname(rootPath)}/checks.rs`;
    const wrongChild = `${crate}/${rootPath.slice(0, -3)}/checks.rs`;
    const childSource = "fn helper() { Instant::now(); }";
    const sources = {
      [`${crate}/Cargo.toml`]: `[package]\nname = "target-root"\nversion = "0.1.0"\n${targetManifest}`,
      [rootFile]: `${wholeFileTest ? "" : "#[cfg(test)] "}mod checks;\nfn main() {}`,
      [sibling]: childSource,
      [wrongChild]: childSource,
    };
    try {
      for (const [file, source] of Object.entries(sources)) {
        mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
        writeFileSync(path.join(repoRoot, file), source);
      }
      const files = discoverRustTestFiles(repoRoot, Object.keys(sources));
      expect(files).toHaveLength(3);
      expect(files).toContainEqual({
        file: rootFile,
        crate,
        integrationTest: wholeFileTest,
      });
      expect(files).toContainEqual({
        file: sibling,
        crate,
        integrationTest: true,
      });
      expect(files).toContainEqual({
        file: wrongChild,
        crate,
        integrationTest: false,
      });
      for (const { file, integrationTest } of files) {
        if (file === rootFile) {
          continue;
        }
        expect(
          scanRustTestDeterminism({ source: childSource, integrationTest }),
        ).toEqual(
          file === sibling ? [{ line: 1, kind: "clock", escaped: false }] : [],
        );
      }
      expect(
        discoverRustTestFiles(repoRoot, Object.keys(sources).toReversed()),
      ).toEqual(files);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

test.each([
  "impl<T> Helper<T>",
  "impl Trait for Helper",
  "unsafe impl Send for Helper",
  "default impl Trait for Helper",
  "#[allow(dead_code)] impl<'a, T> Trait for Helper<'a, T> where T: Clone",
])("test scope covers associated helpers in %s", (header) => {
  const source = `#[cfg(test)] ${header} {
  fn helper() { thread::sleep(duration); }
}
impl Production { fn helper() { Instant::now(); } }`;
  expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual([
    { line: 2, kind: "sleep", escaped: false },
  ]);
});

test.each(["", "#[cfg(not(test))]"])(
  "production impl helpers stay outside test scope: %s",
  (attribute) => {
    const source = `${attribute} impl Production {
  fn helper() { thread::sleep(duration); }
}
#[test] fn example() { Instant::now(); }`;
    expect(scanRustTestDeterminism({ source, integrationTest: false })).toEqual(
      [{ line: 4, kind: "clock", escaped: false }],
    );
  },
);

test.each([
  "fn helper( { thread::sleep(duration); }",
  "mod helpers",
  "impl<T Helper<T> { fn helper() { thread::sleep(duration); } }",
])("unparseable test items fail with their repository location: %s", (item) => {
  const source = `// Header documentation\n#[cfg(test)] ${item}`;
  expect(() =>
    scanRustTestDeterminism({
      source,
      integrationTest: false,
      file: FILE,
    }),
  ).toThrow(`cannot parse test item at ${FILE}:2`);
});

test("unparseable test items retain a source location without an explicit filename", () => {
  expect(() =>
    scanRustTestDeterminism({
      source:
        "// Header documentation\n#[cfg(test)] fn helper( { thread::sleep(duration); }",
      integrationTest: false,
    }),
  ).toThrow("cannot parse test item at <source>:2");
});

test("external test module declarations remain valid without an inline body", () => {
  expect(
    scanRustTestDeterminism({
      source: "#[cfg(test)] mod checks;\nfn production() { Instant::now(); }",
      integrationTest: false,
      file: FILE,
    }),
  ).toEqual([]);
});

test("discovery passes the tracked filename into test-item parse failures", () => {
  const repoRoot = mkdtempSync(
    path.join(tmpdir(), "rust-malformed-test-discovery-"),
  );
  const sources = {
    "crates/example/Cargo.toml":
      '[package]\nname = "example"\nversion = "0.1.0"',
    [FILE]:
      "// Header documentation\n#[cfg(test)] fn helper( { thread::sleep(duration); }",
  };
  try {
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
      writeFileSync(path.join(repoRoot, file), source);
    }
    expect(() => discoverRustTestFiles(repoRoot, Object.keys(sources))).toThrow(
      `cannot parse test item at ${FILE}:2`,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
