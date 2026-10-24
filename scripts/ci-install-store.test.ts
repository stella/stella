import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  completeInstallStoreKey,
  installStorePath,
  parseGlobalStoreMode,
  parseInstallFlags,
  sealInstallStore,
  verifyInstallStore,
} from "./ci-install-store";
import {
  flattenWorkflowSteps,
  workflowCiInstallFlags,
  workflowJobSteps,
} from "./workflow-steps";

const flags = [
  "--frozen-lockfile",
  "--ignore-scripts",
  "--filter",
  "@stll/api",
  "--filter",
  "@stll/cli",
];

const identity = {
  platform: "linux",
  arch: "x64",
  revision: "bun-revision-123",
  globalStoreMode: "enabled" as const,
};

const lockFixture = () => ({
  lockfileVersion: 3,
  workspaces: {
    "": { name: "stella", version: "0.1.0" },
    "apps/api": {
      name: "@stll/api",
      version: "0.1.0",
      dependencies: { example: "^1.0.0" },
    },
  },
  packages: { example: ["example@1.0.0", "", {}, "sha512-first"] },
});

const makeRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "bun-install-key-"));
  writeFileSync(path.join(root, "bun.lock"), JSON.stringify(lockFixture()));
  writeFileSync(
    path.join(root, "bunfig.toml"),
    '[install]\nlinker = "hoisted"\n',
  );
  return root;
};

type InstallStoreOverrides = Partial<
  Pick<
    Parameters<typeof completeInstallStoreKey>[0],
    "platform" | "arch" | "revision" | "globalStoreMode"
  >
>;

const keyFor = (root: string, options: InstallStoreOverrides = {}) =>
  completeInstallStoreKey({ root, flags, ...identity, ...options });

test("v4 keys bind ordered flags, required config and the full runtime identity", () => {
  const root = makeRoot();
  try {
    const key = keyFor(root);
    expect(key).toStartWith(
      "bun-complete-store-v4-linux-x64-bun-revision-123-enabled-",
    );
    expect(keyFor(root)).toBe(key);
    expect(
      completeInstallStoreKey({
        root,
        flags: [
          "--frozen-lockfile",
          "--ignore-scripts",
          "--filter",
          "@stll/cli",
          "--filter",
          "@stll/api",
        ],
        ...identity,
      }),
    ).not.toBe(key);
    expect(
      completeInstallStoreKey({
        root,
        flags: [...flags, "--production"],
        ...identity,
      }),
    ).not.toBe(key);
    for (const override of [
      { platform: "darwin" },
      { arch: "arm64" },
      { revision: "bun-revision-456" },
      { globalStoreMode: "disabled" as const },
    ]) {
      expect(keyFor(root, override)).not.toBe(key);
    }

    writeFileSync(
      path.join(root, "bun.lock"),
      JSON.stringify({ ...lockFixture(), lockfileVersion: 4 }),
    );
    expect(keyFor(root)).not.toBe(key);
    writeFileSync(path.join(root, "bun.lock"), JSON.stringify(lockFixture()));
    writeFileSync(
      path.join(root, "bunfig.toml"),
      '[install]\nlinker = "isolated"\n',
    );
    expect(keyFor(root)).not.toBe(key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace self versions preserve the key while installed dependency inputs change it", () => {
  const root = makeRoot();
  try {
    const baseline = keyFor(root);
    const lock = lockFixture();
    lock.workspaces[""].version = "0.2.0";
    lock.workspaces["apps/api"].version = "0.2.0";
    const source = JSON.stringify(lock);
    expect(source).not.toBe(JSON.stringify(lockFixture()));
    // Bun lockfiles permit comments and trailing commas.
    writeFileSync(
      path.join(root, "bun.lock"),
      `// lock\n${source.slice(0, -1)},}`,
    );
    expect(keyFor(root)).toBe(baseline);

    lock.workspaces["apps/api"].dependencies.example = "^2.0.0";
    lock.packages.example = ["example@2.0.0", "", {}, "sha512-first"];
    writeFileSync(path.join(root, "bun.lock"), JSON.stringify(lock));
    expect(keyFor(root)).not.toBe(baseline);

    const integrityChange = lockFixture();
    integrityChange.packages.example = [
      "example@1.0.0",
      "",
      {},
      "sha512-second",
    ];
    writeFileSync(path.join(root, "bun.lock"), JSON.stringify(integrityChange));
    expect(keyFor(root)).not.toBe(baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key generation rejects missing inputs, empty identities and incomplete flags", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bun-install-missing-"));
  try {
    expect(() => keyFor(root)).toThrow("Missing bun.lock");
    writeFileSync(path.join(root, "bun.lock"), JSON.stringify(lockFixture()));
    expect(() => keyFor(root)).toThrow("Missing required bunfig.toml");
    writeFileSync(path.join(root, "bunfig.toml"), "[install]\n");

    for (const options of [{ platform: "" }, { arch: " " }, { revision: "" }]) {
      expect(() => keyFor(root, options)).toThrow("Missing install-store");
    }
    for (const invalidFlags of [
      [],
      ["", "--frozen-lockfile", "--ignore-scripts"],
      ["--frozen-lockfile"],
      ["--ignore-scripts"],
    ]) {
      expect(() =>
        completeInstallStoreKey({
          root,
          flags: invalidFlags,
          ...identity,
        }),
      ).toThrow(/Install-store cache requires/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global-store mode parsing defaults on and rejects ambiguous values", () => {
  expect(parseGlobalStoreMode(undefined)).toBe("enabled");
  expect(parseGlobalStoreMode("1")).toBe("enabled");
  expect(parseGlobalStoreMode("0")).toBe("disabled");
  expect(parseGlobalStoreMode("false")).toBe("disabled");
  expect(() => parseGlobalStoreMode("off")).toThrow(
    "must be 0, 1, false or true",
  );
});

test("install flags must be a JSON array of strings", () => {
  expect(() => parseInstallFlags(undefined)).toThrow(
    "STELLA_CI_INSTALL_FLAGS must be a JSON array",
  );
  expect(() => parseInstallFlags('{"--frozen-lockfile":true}')).toThrow(
    "STELLA_CI_INSTALL_FLAGS must be a JSON array of strings",
  );
  expect(() => parseInstallFlags('["--frozen-lockfile",null]')).toThrow(
    "STELLA_CI_INSTALL_FLAGS must be a JSON array of strings",
  );
  expect(parseInstallFlags('["--frozen-lockfile","--ignore-scripts"]')).toEqual(
    ["--frozen-lockfile", "--ignore-scripts"],
  );
});

test("sealing accepts a populated package cache without links when the global store is off", () => {
  const store = mkdtempSync(path.join(tmpdir(), "bun-package-cache-"));
  const options = {
    store,
    key: "package-cache-key",
    globalStoreMode: "disabled" as const,
  };
  try {
    mkdirSync(path.join(store, "@stll"));
    writeFileSync(path.join(store, "@stll/api.tgz"), "package archive");
    expect(() => verifyInstallStore(options)).toThrow(
      "Incomplete or mismatched",
    );
    sealInstallStore(options);
    verifyInstallStore(options);

    const marker = path.join(store, ".stella-install-complete");
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toMatchObject({
      format: "v4",
      key: "package-cache-key",
      globalStoreMode: "disabled",
    });
    expect(() =>
      verifyInstallStore({ ...options, globalStoreMode: "enabled" }),
    ).toThrow("Global Bun install store is missing its links directory");
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test.each(["@stll/example.tmp", "example.tmp"])(
  "legitimate package directory %s can be sealed",
  (packageName) => {
    const store = mkdtempSync(path.join(tmpdir(), "bun-package-dot-tmp-"));
    const packageDirectory = path.join(store, packageName);
    const options = {
      store,
      key: "package-dot-tmp-key",
      globalStoreMode: "disabled" as const,
    };
    try {
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(
        path.join(packageDirectory, "package.json"),
        JSON.stringify({ name: packageName }),
      );
      sealInstallStore(options);
      verifyInstallStore(options);
      if (!packageName.startsWith("@")) {
        writeFileSync(
          path.join(packageDirectory, "package.json"),
          JSON.stringify({ name: "different-package" }),
        );
        expect(() => sealInstallStore(options)).toThrow(
          "Incomplete Bun install store",
        );
      }
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  },
);

for (const globalStoreMode of ["enabled", "disabled"] as const) {
  test(`only empty root scratch is accepted with the global store ${globalStoreMode}`, () => {
    const store = mkdtempSync(path.join(tmpdir(), "bun-empty-scratch-"));
    const options = { store, key: "empty-scratch-key", globalStoreMode };
    const scratch = path.join(store, ".tmp");
    const rejectsScratch = () => {
      expect(() => sealInstallStore(options)).toThrow(
        "Incomplete Bun install store",
      );
      expect(() => verifyInstallStore(options)).toThrow(
        "Incomplete Bun install store",
      );
    };
    try {
      mkdirSync(scratch);
      expect(() => sealInstallStore(options)).toThrow(
        "Empty Bun install store",
      );
      mkdirSync(path.join(store, "package/empty"), { recursive: true });
      writeFileSync(
        path.join(store, "package/value.js"),
        "export const value = 1;\n",
      );
      mkdirSync(path.join(store, "links"));
      symlinkSync("../package", path.join(store, "links/package"));
      sealInstallStore(options);
      verifyInstallStore(options);

      mkdirSync(path.join(scratch, "unfinished"));
      rejectsScratch();
      rmSync(scratch, { recursive: true });
      writeFileSync(scratch, "unfinished extraction");
      rejectsScratch();
      rmSync(scratch);
      symlinkSync("package/empty", scratch, "dir");
      rejectsScratch();
      rmSync(scratch);
      mkdirSync(scratch);
      writeFileSync(path.join(scratch, "partial"), "unfinished extraction");
      rejectsScratch();
      rmSync(scratch, { recursive: true });
      mkdirSync(scratch);
      verifyInstallStore(options);

      mkdirSync(path.join(store, "links/.tmp"));
      rejectsScratch();
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
}

test("sealing requires populated links for global stores and rejects partial stores", () => {
  const store = mkdtempSync(path.join(tmpdir(), "bun-global-store-"));
  const options = {
    store,
    key: "global-store-key",
    globalStoreMode: "enabled" as const,
  };
  try {
    expect(() => sealInstallStore(options)).toThrow("Empty Bun install store");
    mkdirSync(path.join(store, "package"));
    writeFileSync(
      path.join(store, "package/value.js"),
      "export const value = 1;\n",
    );
    expect(() => sealInstallStore(options)).toThrow(
      "missing its links directory",
    );
    mkdirSync(path.join(store, "links"));
    expect(() => sealInstallStore(options)).toThrow(
      "Empty Bun install-store links directory",
    );
    symlinkSync("../package", path.join(store, "links/package"));
    sealInstallStore(options);
    verifyInstallStore(options);

    mkdirSync(path.join(store, "partial.tmp"));
    expect(() => verifyInstallStore(options)).toThrow(
      "Incomplete Bun install store",
    );
    expect(() => sealInstallStore(options)).toThrow(
      "Incomplete Bun install store",
    );
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test("the ci-install composite restores and saves only the exact sealed cache", () => {
  const action = v.parse(
    v.object({
      outputs: v.object({
        "cache-hit": v.object({ value: v.string() }),
        key: v.object({ value: v.string() }),
        "restore-ms": v.object({ value: v.string() }),
        "install-ms": v.object({ value: v.string() }),
      }),
      runs: v.object({
        using: v.literal("composite"),
        steps: v.array(v.record(v.string(), v.unknown())),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(
        path.resolve(
          import.meta.dirname,
          "../.github/actions/ci-install/action.yml",
        ),
        "utf-8",
      ),
    ),
  );
  const steps = flattenWorkflowSteps(action.runs.steps);
  const step = (id: string) => {
    const found = steps.find((entry) => entry["id"] === id);
    if (found === undefined) {
      expect.unreachable(`Missing ci-install action step ${id}`);
    }
    return found;
  };
  const identityStep = step("identity");
  const restore = step("cache");
  const verify = step("restore-time");
  const install = step("install");
  const seal = step("install-time");
  const save = steps.find(
    (entry) => entry["uses"] === "$/.github/actions/ci-store-save",
  );
  if (save === undefined) {
    expect.unreachable("Missing main-only ci-install cache save");
  }
  const cacheInputs = (candidate: Record<string, unknown>) =>
    v.parse(v.object({ path: v.string(), key: v.string() }), candidate["with"]);
  const restoreInputs = cacheInputs(restore);
  const saveInputs = cacheInputs(save);
  const stepsByOrder = [identityStep, restore, verify, install, seal, save].map(
    (entry) => steps.indexOf(entry),
  );

  expect(identityStep["run"]).toContain(
    'bun scripts/ci-install-store.ts key >> "$GITHUB_OUTPUT"',
  );
  expect(action.outputs["cache-hit"].value).toBe(
    `\${{ steps.cache.outputs.cache-hit }}`,
  );
  expect(action.outputs.key.value).toBe(`\${{ steps.identity.outputs.key }}`);
  expect(action.outputs["restore-ms"].value).toBe(
    `\${{ steps.restore-time.outputs.milliseconds }}`,
  );
  expect(action.outputs["install-ms"].value).toBe(
    `\${{ steps.install-time.outputs.milliseconds }}`,
  );
  expect(restore["uses"]).toMatch(/^actions\/cache\/restore@[0-9a-f]{40}/u);
  expect(save["continue-on-error"]).toBe(true);
  expect(restoreInputs).toEqual({
    path: `\${{ steps.identity.outputs.store }}`,
    key: `\${{ steps.identity.outputs.key }}`,
  });
  expect(saveInputs).toEqual(restoreInputs);
  expect(restore["with"]).not.toHaveProperty("restore-keys");
  const verifyEnv = v.parse(
    v.object({
      CACHE_HIT: v.string(),
      STORE_KEY: v.string(),
      START_MS: v.string(),
    }),
    verify["env"],
  );
  expect(verifyEnv.CACHE_HIT).toBe(`\${{ steps.cache.outputs.cache-hit }}`);
  const verifyRun = v.parse(v.string(), verify["run"]);
  expect(verifyRun).toContain('if [[ "$CACHE_HIT" == true ]]; then');
  expect(verifyRun).toContain(
    'if ! bun scripts/ci-install-store.ts verify "$STORE_KEY"; then',
  );
  // An invalid archive under an immutable key falls back to a cold install.
  expect(verifyRun).toContain("title=install-store-invalid");
  expect(verifyRun).toContain('rm -rf "$BUN_INSTALL_CACHE_DIR"');
  expect(verifyRun).toContain(
    'echo "milliseconds=$((end - START_MS))" >> "$GITHUB_OUTPUT"',
  );
  expect(verifyRun.indexOf("end=$(bun -e")).toBeGreaterThan(
    verifyRun.indexOf("fi"),
  );
  expect(seal["if"]).toBe(
    `\${{ always() && steps.install.outcome != 'skipped' }}`,
  );
  const sealEnv = v.parse(
    v.object({
      INSTALL_OUTCOME: v.string(),
      STORE_KEY: v.string(),
      START_MS: v.string(),
    }),
    seal["env"],
  );
  expect(sealEnv.INSTALL_OUTCOME).toBe(`\${{ steps.install.outcome }}`);
  const sealRun = v.parse(v.string(), seal["run"]);
  expect(sealRun).toContain(
    'if [[ "$INSTALL_OUTCOME" == success && "$CACHE_WRITE" == save',
  );
  expect(seal["continue-on-error"]).toBe(true);
  expect(sealRun).toContain(
    'bun scripts/ci-install-store.ts seal "$STORE_KEY"',
  );
  expect(sealRun).toContain(
    'echo "milliseconds=$((end - START_MS))" >> "$GITHUB_OUTPUT"',
  );
  expect(sealRun.indexOf("end=$(bun -e")).toBeGreaterThan(
    sealRun.indexOf("fi"),
  );
  expect(save["if"]).toContain("github.ref == 'refs/heads/main'");
  expect(stepsByOrder).toEqual(stepsByOrder.toSorted((a, b) => a - b));

  const upload = steps.find(
    (entry) =>
      typeof entry["uses"] === "string" &&
      entry["uses"].startsWith("actions/upload-artifact@"),
  );
  expect(upload?.["uses"]).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}/u);
  expect(upload?.["if"]).toBe("failure()");
  const uploadInputs = v.parse(
    v.object({ path: v.string(), "retention-days": v.number() }),
    upload?.["with"],
  );
  expect(uploadInputs.path).toBe(`\${{ runner.temp }}/bun-install/*.log`);
  expect(uploadInputs["retention-days"]).toBe(7);
  for (const entry of steps) {
    // Composite metadata supports caller timeouts, not nested step timeouts.
    expect(entry).not.toHaveProperty("timeout-minutes");
  }
});

test("the manual install-cache benchmark is dispatch-only and reports measured phases", () => {
  const manual = v.parse(
    v.object({
      on: v.object({
        workflow_dispatch: v.object({
          inputs: v.object({
            check: v.object({ options: v.array(v.string()) }),
          }),
        }),
      }),
      jobs: v.record(v.string(), v.unknown()),
    }),
    Bun.YAML.parse(
      readFileSync(
        path.resolve(
          import.meta.dirname,
          "../.github/workflows/manual-checks.yml",
        ),
        "utf-8",
      ),
    ),
  );
  expect(Object.keys(manual.on)).toEqual(["workflow_dispatch"]);
  expect(manual.on.workflow_dispatch.inputs.check.options).toContain(
    "install-cache-benchmark",
  );

  const benchmark = (job: string) =>
    v.parse(
      v.object({
        if: v.string(),
        env: v.record(v.string(), v.string()),
        strategy: v.optional(
          v.object({
            matrix: v.object({ "global-store": v.array(v.string()) }),
          }),
        ),
        steps: v.array(v.record(v.string(), v.unknown())),
      }),
      manual.jobs[job],
    );
  const windows = benchmark("install-cache-windows");
  const linux = benchmark("install-cache-linux");
  const benchmarkCondition = "inputs.check == 'install-cache-benchmark'";
  expect(windows.if).toBe(benchmarkCondition);
  expect(linux.if).toBe(
    `${benchmarkCondition} || inputs.check == 'store-cache-save-benchmark'`,
  );
  expect(windows.strategy?.matrix["global-store"]).toEqual(["0", "1"]);
  expect(windows.env["BUN_INSTALL_GLOBAL_STORE"]).toBe(
    `\${{ matrix.global-store }}`,
  );
  expect(linux.env["BUN_INSTALL_GLOBAL_STORE"]).toBe("1");

  const measure = (job: typeof windows, expectedFlags: string[]) => {
    const install = job.steps.find(
      (step) => step["name"] === "Measure scoped install",
    );
    if (install === undefined) {
      expect.unreachable("Missing benchmark install step");
    }
    expect(v.parse(v.string(), install["uses"])).toBe(
      "$/.github/actions/ci-install",
    );
    expect(install).not.toHaveProperty("timeout-minutes");
    const withInputs = v.parse(
      v.object({ flags: v.string() }),
      install["with"],
    );
    expect(JSON.parse(withInputs.flags)).toEqual(expectedFlags);

    const report = job.steps.find(
      (step) => step["name"] === "Report measured phases",
    );
    if (report === undefined) {
      expect.unreachable("Missing benchmark report step");
    }
    const reportEnv = v.parse(
      v.object({
        CACHE_HIT: v.string(),
        STORE_KEY: v.string(),
        RESTORE_MS: v.string(),
        INSTALL_MS: v.string(),
        INSTALL_OUTCOME: v.string(),
      }),
      report["env"],
    );
    expect(reportEnv.RESTORE_MS).toContain("outputs.restore-ms");
    expect(reportEnv.INSTALL_MS).toContain("outputs.install-ms");
    const run = v.parse(v.string(), report["run"]);
    expect(run).toContain("restoreMs: ms(process.env.RESTORE_MS)");
    expect(run).toContain("installMs: ms(process.env.INSTALL_MS)");
    expect(run).toContain("Number(value)");
    expect(run).not.toMatch(/(?:restoreMs|installMs):\s*\d+/u);
  };

  const windowsInstall = workflowJobSteps(
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    ),
    "desktop-windows-dry-run",
  ).find((step) => step["uses"] === "$/.github/actions/ci-install");
  if (windowsInstall === undefined) {
    expect.unreachable("Missing Windows desktop install");
  }
  measure(windows, workflowCiInstallFlags(windowsInstall));
  measure(linux, ["--frozen-lockfile", "--ignore-scripts"]);
});

// Astro (vite-plugin-utils normalizeFilename) treats an absolute id as
// project-relative unless it shares a non-root ancestor with the project.
const astroSeesPathInRoot = (filename: string, root: string) => {
  const a = filename.split("/");
  const b = root.split("/");
  const common: string[] = [];
  for (const [index, part] of a.entries()) {
    if (part !== b[index]) {
      break;
    }
    common.push(part);
  }
  return common.join("/") !== "";
};

test("hosted Linux jobs and job containers share one store path Astro can load from", () => {
  const host = installStorePath({
    key: "k",
    platform: "linux",
    runnerTemp: "/home/runner/work/_temp",
    workspace: "/home/runner/work/stella/stella",
  });
  const container = installStorePath({
    key: "k",
    platform: "linux",
    runnerTemp: "/__w/_temp",
    workspace: "/__w/stella/stella",
  });
  expect(host).toEqual({
    store: "/home/runner/work/_temp/bun-scoped-install/k",
    alias: undefined,
  });
  expect(container).toEqual({
    store: "/home/runner/work/_temp/bun-scoped-install/k",
    alias: { link: "/home/runner/work", target: "/__w" },
  });
  expect(
    astroSeesPathInRoot(
      host.store,
      "/home/runner/work/stella/stella/apps/landing",
    ),
  ).toBe(true);
  expect(
    astroSeesPathInRoot(
      "/__w/_temp/bun-scoped-install/k",
      "/__w/stella/stella/apps/landing",
    ),
  ).toBe(true);
  expect(
    astroSeesPathInRoot(
      "/tmp/bun-scoped-install/k",
      "/home/runner/work/stella/stella/apps/landing",
    ),
  ).toBe(false);
});

test("other runners keep RUNNER_TEMP and a store outside the workspace tree fails", () => {
  expect(
    installStorePath({
      key: "k",
      platform: "darwin",
      runnerTemp: "/opt/runner/work/_temp",
      workspace: "/opt/runner/work/stella/stella",
    }),
  ).toEqual({
    store: "/opt/runner/work/_temp/bun-scoped-install/k",
    alias: undefined,
  });
  expect(() =>
    installStorePath({
      key: "k",
      platform: "linux",
      runnerTemp: "/tmp",
      workspace: "/home/runner/work/stella/stella",
    }),
  ).toThrow("shares no non-root ancestor");
});

test("ci-install aliases the hosted work directory before restoring the store", () => {
  const source = readFileSync(
    path.join(import.meta.dir, "../.github/actions/ci-install/action.yml"),
    "utf-8",
  );
  const alias = source.indexOf(
    "Alias the hosted work directory inside job containers",
  );
  const restore = source.indexOf("Restore exact complete install store");
  expect(alias).toBeGreaterThan(-1);
  expect(alias).toBeLessThan(restore);
});
