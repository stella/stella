import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeGate, runOnce, selectTargets, type Target } from "./flake-gate";
import {
  createRustTestListing,
  rustExactCommand,
  rustTestBelongsToModule,
  selectRustTargets,
} from "./flake-gate-rust";

const withFixture = (run: (root: string) => void) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "flake-gate-rust-"));
  try {
    write(root, "src/lib.rs", "");
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const withAsyncFixture = async (run: (root: string) => Promise<void>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "flake-gate-rust-run-"));
  try {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const write = (root: string, file: string, contents: string) => {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
};

const prepareRustFixture = async (root: string) => {
  const env = { CARGO_TARGET_DIR: path.join(root, "target") };
  // Cold compilation is fixture setup, not part of the discovery/execution
  // deadline. Keep Cargo output local so concurrent fixtures cannot lock it.
  const build = Bun.spawn(["cargo", "test", "--lib", "--no-run"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "pipe",
    timeout: 60_000,
  });
  const [status, stderr] = await Promise.all([
    build.exited,
    new Response(build.stderr).text(),
  ]);
  expect(status, stderr).toBe(0);
  return env;
};

test.each([
  '#[tokio::test(flavor = "multi_thread")]',
  '#[sqlx::test(migrations = "./migrations")]',
  '#[custom::test(options(nested("a ) bracket")))]',
  `#[custom::test(options(r#"quote ")"#, ')', /* ) */ nested()))]`,
])(
  "argument-bearing Rust test attribute selects its changed module: %s",
  (attribute) => {
    withFixture((root) => {
      write(
        root,
        "Cargo.toml",
        '[package]\nname = "fixture"\nversion = "0.1.0"\n',
      );
      write(root, "src/lib.rs", "mod feature;\n");
      write(root, "src/feature.rs", `${attribute}\nasync fn works() {}\n`);
      expect(selectRustTargets(root, ["src/feature.rs"])).toEqual({
        targets: [
          {
            file: "src/feature.rs",
            cwd: root,
            crate: "fixture",
            module: "feature",
          },
        ],
        unsupported: [],
      });
    });
  },
);

test.each([
  '#[tokio::test(flavor = "multi_thread"]',
  "#[tokio::test(options(nested())]",
  '#[tokio::test_helper(flavor = "multi_thread")]',
])(
  "incomplete or non-test Rust attributes do not select tests: %s",
  (attribute) => {
    withFixture((root) => {
      write(
        root,
        "Cargo.toml",
        '[package]\nname = "fixture"\nversion = "0.1.0"\n',
      );
      write(root, "src/lib.rs", `${attribute}\nasync fn works() {}\n`);
      const selected = selectRustTargets(root, ["src/lib.rs"]);
      expect(selected.targets).toEqual([]);
      expect(selected.unsupported).toEqual([
        {
          file: "src/lib.rs",
          reason: "changed file has no test in module <crate>",
        },
      ]);
    });
  },
);

test("changed Rust modules with unit tests select one crate/module target", () => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture-crate"\nversion = "0.1.0"\n',
    );
    write(
      root,
      "src/feature.rs",
      "pub fn feature() {}\n#[cfg(test)]\nmod tests { #[test] fn inline_works() {} }\n",
    );
    write(root, "src/lib.rs", "mod feature;\n");
    write(
      root,
      "src/feature/tests.rs",
      "#[tokio::test]\nasync fn works() {}\n",
    );

    expect(
      selectRustTargets(root, ["src/feature.rs", "src/feature/tests.rs"]),
    ).toEqual({
      targets: [
        {
          file: "src/feature.rs",
          cwd: root,
          crate: "fixture-crate",
          module: "feature",
        },
      ],
      unsupported: [],
    });
  });
});

test("changed files without a discoverable test are reported as unsupported", () => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    );
    write(root, "src/lib.rs", "pub fn library() {}\n");
    write(root, "src/other.rs", "pub fn other() {}\n");

    expect(selectRustTargets(root, ["src/other.rs", "README.md"])).toEqual({
      targets: [],
      unsupported: [
        {
          file: "src/other.rs",
          reason: "changed file has no test in module other",
        },
      ],
    });
  });
});

test("a changed production module does not select an unchanged descendant test", () => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    );
    write(root, "src/feature.rs", "pub fn feature() {}\n");
    write(root, "src/feature/tests.rs", "#[test]\nfn unchanged_test() {}\n");

    expect(selectRustTargets(root, ["src/feature.rs"])).toEqual({
      targets: [],
      unsupported: [
        {
          file: "src/feature.rs",
          reason: "changed file has no test in module feature",
        },
      ],
    });
  });
});

test("deleted and integration-test files remain explicit unsupported cases", () => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    );
    write(
      root,
      "src/lib.rs",
      "#[cfg(test)]\nmod tests { #[test] fn works() {} }\n",
    );
    write(root, "tests/integration.rs", "#[test]\nfn works() {}\n");

    expect(
      selectRustTargets(root, ["src/deleted.rs", "tests/integration.rs"]),
    ).toEqual({
      targets: [],
      unsupported: [
        { file: "src/deleted.rs", reason: "file is deleted or unavailable" },
        {
          file: "tests/integration.rs",
          reason: "non-src Rust targets need an explicit Cargo target selector",
        },
      ],
    });
  });
});

test("changed binary tests require an explicit Cargo binary target", () => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    );
    write(root, "src/bin/worker.rs", "#[test]\nfn works() {}\n");
    write(root, "src/bin/worker/tasks.rs", "#[test]\nfn works() {}\n");
    expect(
      selectRustTargets(root, ["src/bin/worker.rs", "src/bin/worker/tasks.rs"]),
    ).toEqual({
      targets: [],
      unsupported: [
        {
          file: "src/bin/worker.rs",
          reason: "Rust binary tests need an explicit Cargo binary target",
        },
        {
          file: "src/bin/worker/tasks.rs",
          reason: "Rust binary tests need an explicit Cargo binary target",
        },
      ],
    });
  });
});

test("non-Rust changes avoid Cargo manifest discovery", () => {
  expect(selectRustTargets("/missing/repository", ["README.md"])).toEqual({
    targets: [],
    unsupported: [],
  });
});

test("desktop Rust packages are skipped before reaching the hosted runner", () => {
  withFixture((root) => {
    const file = "apps/desktop/src-tauri/src/feature.rs";
    write(
      root,
      "apps/desktop/src-tauri/Cargo.toml",
      '[package]\nname = "stella-desktop"\nversion = "0.1.0"\n',
    );
    write(root, "apps/desktop/src-tauri/src/lib.rs", "mod feature;\n");
    write(root, file, "#[test] fn example() {}\n");
    expect(selectRustTargets(root, [file])).toEqual({
      targets: [],
      unsupported: [
        {
          file,
          reason:
            "desktop Rust tests require platform system dependencies unavailable in the report job",
        },
      ],
    });
  });
});

test.each([
  ["src/main.rs", "Rust main tests need an explicit Cargo binary target"],
  ["src/lib.rs", "custom Rust test harnesses need an explicit runner"],
] as const)("unsupported Rust target %s stays explicit", (file, reason) => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      `[package]\nname = "fixture"\nversion = "0.1.0"\n${file === "src/lib.rs" ? "[lib]\nharness = false\n" : ""}`,
    );
    write(root, file, "#[test] fn example() {}\n");
    expect(selectRustTargets(root, [file])).toEqual({
      targets: [],
      unsupported: [{ file, reason }],
    });
  });
});

test("modules in a binary-only crate are not treated as library tests", () => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture"\nversion = "0.1.0"\nautolib = false\n',
    );
    write(root, "src/feature.rs", "#[test] fn example() {}\n");
    expect(selectRustTargets(root, ["src/feature.rs"]).unsupported).toEqual([
      {
        file: "src/feature.rs",
        reason: "package has no automatic Rust library target",
      },
    ]);
  });
});

test("listing membership accepts only the exact module and descendants", () => {
  const names = [
    "feature",
    "feature::works",
    "feature::nested::works",
    "other_feature::fails",
    "feature_suffix::fails",
    "nested::feature::fails",
  ];
  expect(
    names.filter((name) =>
      rustTestBelongsToModule({ name, module: "feature" }),
    ),
  ).toEqual(names.slice(0, 3));
  const listing = createRustTestListing("feature");
  for (const name of names) {
    listing.acceptLine(`${name}: test`);
  }
  listing.acceptLine("feature::benchmark: benchmark");
  expect(listing.batches().flat()).toEqual(names.slice(0, 3).toSorted());
  expect(
    rustExactCommand({ crate: "fixture", names: ["feature::works"] }),
  ).toEqual([
    "cargo",
    "test",
    "-p",
    "fixture",
    "--lib",
    "--color=never",
    "--",
    "--exact",
    "--test-threads=1",
    "feature::works",
  ]);
});

test("listing batches preserve every selected name within bounded arguments and fail explicitly on overflow", () => {
  const names = Array.from(
    { length: 500 },
    (_, index) => `feature::test_${index}_${"x".repeat(300)}`,
  );
  const listing = createRustTestListing("feature");
  for (const name of names) {
    listing.acceptLine(`${name}: test`);
  }
  expect(listing.batches().length).toBeGreaterThan(1);
  expect(listing.batches().flat()).toEqual(names.toSorted());
  expect(() =>
    listing.acceptLine(`feature::${"x".repeat(30_000)}: test`),
  ).toThrow("exact-test argument budget");
  const overflowing = createRustTestListing("feature");
  expect(() => {
    for (let index = 0; index < 300; index += 1) {
      overflowing.acceptLine(
        `feature::test_${index}_${"x".repeat(20_000)}: test`,
      );
    }
  }).toThrow("selected-name budget");
});

// Measured p95 is 39.4 s; this test must compile and run a real Cargo fixture.
test("a real Cargo module excludes failing substring siblings and unrelated binary tests", async () => {
  await withAsyncFixture(async (root) => {
    write(root, "src/lib.rs", "mod feature; mod other_feature;\n");
    write(
      root,
      "src/feature.rs",
      "#[test] fn works() {}\nmod nested { #[test] fn also_works() {} }\n",
    );
    write(
      root,
      "src/other_feature.rs",
      '#[test] fn fails() { panic!("unrelated substring sibling"); }\n',
    );
    write(
      root,
      "src/main.rs",
      'fn main() {}\n#[test] fn feature_binary_fails() { panic!("unrelated binary"); }\n',
    );
    const selected = selectTargets({
      root,
      changed: ["src/feature.rs"],
      hasDb: false,
    });
    expect(selected.skipped).toEqual([]);
    expect(selected.targets).toEqual([
      {
        file: "src/feature.rs",
        cwd: root,
        env: {},
        crate: "fixture",
        module: "feature",
        runner: "rust",
      },
    ]);
    const target = selected.targets.at(0);
    if (!target) {
      throw new TypeError("Expected real Rust module target");
    }
    const env = await prepareRustFixture(root);
    expect(
      await runOnce({ target: { ...target, env }, seed: 1, timeoutMs: 20_000 }),
    ).toEqual({
      type: "executed",
      passed: true,
      status: 0,
      ranTests: true,
      failedTests: [],
    });
  });
}, 80_000);

test("real Cargo modules absent on this target and ignored-only modules are reported as typed skips", async () => {
  await withAsyncFixture(async (root) => {
    write(root, "src/lib.rs", "mod feature; mod ignored_feature;\n");
    write(
      root,
      "src/feature.rs",
      '#[cfg(target_os = "none")] #[test] fn unavailable() {}\n',
    );
    write(
      root,
      "src/ignored_feature.rs",
      '#[ignore] #[test] fn ignored() { panic!("must stay ignored"); }\n',
    );
    const env = await prepareRustFixture(root);
    const selected = selectTargets({
      root,
      changed: ["src/feature.rs", "src/ignored_feature.rs"],
      hasDb: false,
    });
    const report = await executeGate({
      ...selected,
      targets: selected.targets.map((target) => ({ ...target, env })),
      budgetMs: 20_000,
    });
    expect(report.errors).toEqual([]);
    expect(report.results).toEqual([]);
    expect(report.skipped).toEqual([
      {
        file: "src/feature.rs",
        reason: "not gated (no tests in module feature)",
      },
      {
        file: "src/ignored_feature.rs",
        reason: "not gated (all tests in module ignored_feature are ignored)",
      },
    ]);
  });
}, 90_000);

const fakeCargoTarget = (root: string, source: string): Target => {
  const executable = path.join(root, "bin/cargo");
  write(root, "bin/cargo", `#!${process.execPath}\n${source}`);
  chmodSync(executable, 0o755);
  return {
    file: "src/feature.rs",
    cwd: root,
    env: {
      PATH: `${path.join(root, "bin")}${path.delimiter}${process.env["PATH"] ?? ""}`,
    },
    crate: "fixture",
    module: "feature",
    runner: "rust",
  };
};

test("successful listing followed by zero exact executions fails rather than becoming a skip", async () => {
  await withAsyncFixture(async (root) => {
    const target = fakeCargoTarget(
      root,
      `console.log(Bun.argv.includes("--list") ? "feature::works: test" : "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out;");`,
    );
    expect(await runOnce({ target, seed: 1, timeoutMs: 5000 })).toEqual({
      type: "executed",
      passed: false,
      status: 0,
      ranTests: false,
      failedTests: [],
    });
  });
});

test("listing and exact execution consume one shared deadline", async () => {
  await withAsyncFixture(async (root) => {
    // Leave room for process startup under load while keeping the two
    // successful phases longer than their shared deadline.
    const phaseDelayMs = 2000;
    const timeoutMs = 3000;
    const target = fakeCargoTarget(
      root,
      `await Bun.write(Bun.argv.includes("--list") ? "listed" : "executed", "yes"); await Bun.sleep(${phaseDelayMs}); console.log(Bun.argv.includes("--list") ? "feature::works: test" : "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;");`,
    );
    expect(await runOnce({ target, seed: 1, timeoutMs })).toEqual({
      type: "executed",
      passed: false,
      status: 124,
      ranTests: false,
      failedTests: [],
    });
    expect(await Bun.file(path.join(root, "listed")).exists()).toBe(true);
    expect(await Bun.file(path.join(root, "executed")).exists()).toBe(true);
  });
});

test("a hanging Cargo listing is terminated by the trial deadline", async () => {
  await withAsyncFixture(async (root) => {
    const target = fakeCargoTarget(root, "setInterval(() => {}, 1000);");
    expect(await runOnce({ target, seed: 1, timeoutMs: 150 })).toEqual({
      type: "executed",
      passed: false,
      status: 124,
      ranTests: false,
      failedTests: [],
    });
  });
});

test("workspace manifests resolve files to the nearest package", () => {
  withFixture((root) => {
    write(root, "Cargo.toml", '[workspace]\nmembers = ["crates/inner"]\n');
    write(
      root,
      "crates/inner/Cargo.toml",
      '[package]\nname = "inner"\nversion = "0.1.0"\n',
    );
    write(
      root,
      "crates/inner/src/lib.rs",
      "#[cfg(test)]\nmod tests { #[test] fn works() {} }\n",
    );

    expect(selectRustTargets(root, ["crates/inner/src/lib.rs"])).toEqual({
      targets: [
        {
          file: "crates/inner/src/lib.rs",
          cwd: path.join(root, "crates/inner"),
          crate: "inner",
          module: "",
        },
      ],
      unsupported: [],
    });
  });
});
