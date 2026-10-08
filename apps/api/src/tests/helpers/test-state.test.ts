import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const runLifecycleFixture = (source: string | readonly string[]) => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-state-lifecycle-"));
  const token = Bun.randomUUIDv7().replaceAll("-", "_");
  const existingKey = `STELLA_TEST_STATE_EXISTING_${token}`;
  const absentKey = `STELLA_TEST_STATE_ABSENT_${token}`;
  const helper = path.join(import.meta.dir, "test-state.ts");
  try {
    writeFileSync(
      path.join(directory, "shared-state.ts"),
      'export const shared = { config: { value: "original-config" }, completedFiles: 0 };\n',
    );
    const sources = typeof source === "string" ? [source] : source;
    const files = sources.map((fixture, index) => {
      const file = path.join(directory, `lifecycle-${index}.test.ts`);
      writeFileSync(
        file,
        `import { afterAll, afterEach, expect, test } from "bun:test";
import { createTestState } from ${JSON.stringify(helper)};
import { shared } from "./shared-state.ts";
const existingKey = ${JSON.stringify(existingKey)};
const absentKey = ${JSON.stringify(absentKey)};
${fixture}
`,
      );
      return file;
    });
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--no-env-file", "test", ...files],
      cwd: directory,
      env: { [existingKey]: "original-env" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return {
      exitCode: child.exitCode,
      output: child.stdout.toString() + child.stderr.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("restoring fixtures preserve file defaults and original configuration descriptors", () => {
  const child = runLifecycleFixture(`
const config: { value: string; undef: string | undefined; absent?: string } = {
  value: "original-config",
  undef: undefined,
};
Object.defineProperty(config, "undef", {
  value: undefined, writable: true, configurable: true, enumerable: false,
});

const originalDescriptors = Object.getOwnPropertyDescriptors(config);
const state = createTestState({ file: import.meta.path, config });
state.setEnv(existingKey, "file-env");
state.setEnv(absentKey, "file-absent-env");
state.setConfig("value", "file-config");
state.setConfig("undef", "file-undefined-config");
let restoredTests = 0;
afterEach(() => {
  expect(process.env[existingKey]).toBe("file-env");
  expect(process.env[absentKey]).toBe("file-absent-env");
  expect(config.value).toBe("file-config");
  expect(Object.getOwnPropertyDescriptor(config, "undef")).toEqual({
    value: "file-undefined-config", writable: true, configurable: true, enumerable: false,
  });
  expect(Object.hasOwn(config, "absent")).toBe(false);
  restoredTests += 1;
});
afterAll(() => {
  expect(restoredTests).toBe(3);
  expect(process.env[existingKey]).toBe("original-env");
  expect(process.env[absentKey]).toBeUndefined();
  expect(Object.getOwnPropertyDescriptors(config)).toEqual(originalDescriptors);
  console.log("FILE_CLEANUP_VERIFIED");
});
test("repeated first writes capture each test original once", () => {
  expect(config.value).toBe("file-config");
  state.setConfig("value", "first");
  state.setConfig("value", "second");
  state.patchConfig({ value: "third", absent: "first" });
  state.setConfig("absent", "second");
  state.setEnv(existingKey, "first-env");
  state.setEnv(existingKey, "second-env");
  expect(config.value).toBe("third");
  expect(config.absent).toBe("second");
  expect(process.env[existingKey]).toBe("second-env");
});
test("deletion restores existing env and property descriptors", () => {
  expect(config.value).toBe("file-config");
  expect(process.env[existingKey]).toBe("file-env");
  state.deleteEnv(existingKey);
  state.deleteEnv(absentKey);
  state.deleteConfig("undef");
  state.setConfig("undef", undefined);
  state.setConfig("absent", undefined);
  expect(process.env[existingKey]).toBeUndefined();
  expect(process.env[absentKey]).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(config, "undef")?.enumerable).toBe(true);
  expect(Object.hasOwn(config, "absent")).toBe(true);
});
test("later tests retain defaults after multiple restores", () => {
  expect(config.value).toBe("file-config");
  expect(config.undef).toBe("file-undefined-config");
  expect(Object.hasOwn(config, "absent")).toBe(false);
  state.patchConfig({ value: "patched", undef: undefined, absent: "patched" });
  state.deleteConfig("absent");
  state.setConfig("absent", "last");
  expect(config.absent).toBe("last");
});
`);
  expect(child.exitCode, child.output).toBe(0);
  expect(child.output).toContain("FILE_CLEANUP_VERIFIED");
  expect(child.output).toContain("3 pass");
});

test("restoring fixtures clean test and file state after a thrown test failure", () => {
  const child = runLifecycleFixture(`
const config = { value: "original-config" };
const state = createTestState({ file: import.meta.path, config });
state.setConfig("value", "file-config");
state.setEnv(existingKey, "file-env");
let failedTestRestored = false;
afterEach(() => {
  expect(config.value).toBe("file-config");
  expect(process.env[existingKey]).toBe("file-env");
  expect(process.env[absentKey]).toBeUndefined();
  failedTestRestored = true;
  console.log("FAILED_TEST_CLEANUP_VERIFIED");
});
afterAll(() => {
  expect(failedTestRestored).toBe(true);
  expect(config.value).toBe("original-config");
  expect(process.env[existingKey]).toBe("original-env");
  expect(process.env[absentKey]).toBeUndefined();
  console.log("FAILED_FILE_CLEANUP_VERIFIED");
});
test("planted test failure", () => {
  state.setConfig("value", "leaked-config");
  state.setEnv(existingKey, "leaked-env");
  state.setEnv(absentKey, "created-env");
  throw new Error("planted lifecycle failure");
});
`);
  expect(child.exitCode, child.output).toBe(1);
  expect(child.output).toContain("planted lifecycle failure");
  expect(child.output).toContain("FAILED_TEST_CLEANUP_VERIFIED");
  expect(child.output).toContain("FAILED_FILE_CLEANUP_VERIFIED");
  expect(child.output).toContain("1 fail");
});

test("restoring fixtures retain distinct symbol identities and conditional env defaults", () => {
  const child = runLifecycleFixture(`
const first = Symbol("same-description");
const second = Symbol("same-description");
const config = { [first]: "original-first", [second]: "original-second" };
const state = createTestState({ file: import.meta.path, config });
state.setEnvIfAbsent(existingKey, "must-not-replace-original");
state.setEnvIfAbsent(absentKey, "file-default");
state.setConfig(first, "file-first");
state.setConfig(second, "file-second");
afterEach(() => {
  expect(config[first]).toBe("file-first");
  expect(config[second]).toBe("file-second");
  expect(process.env[existingKey]).toBe("original-env");
  expect(process.env[absentKey]).toBe("file-default");
});
afterAll(() => {
  expect(config[first]).toBe("original-first");
  expect(config[second]).toBe("original-second");
  expect(process.env[existingKey]).toBe("original-env");
  expect(process.env[absentKey]).toBeUndefined();
  console.log("SYMBOL_AND_CONDITIONAL_CLEANUP_VERIFIED");
});
test("conditional setup fills only absent keys and captures symbols independently", () => {
  expect(first).not.toBe(second);
  expect(process.env[existingKey]).toBe("original-env");
  expect(process.env[absentKey]).toBe("file-default");
  state.setConfig(first, "test-first");
  state.setConfig(second, "test-second");
  state.patchConfig({ [first]: "patched-first", [second]: "patched-second" });
  state.setEnvIfAbsent(existingKey, "must-not-replace-test-value");
  state.deleteEnv(absentKey);
  state.setEnvIfAbsent(absentKey, "test-default");
  expect(config[first]).toBe("patched-first");
  expect(config[second]).toBe("patched-second");
  expect(process.env[existingKey]).toBe("original-env");
  expect(process.env[absentKey]).toBe("test-default");
});
`);
  expect(child.exitCode, child.output).toBe(0);
  expect(child.output).toContain("SYMBOL_AND_CONDITIONAL_CLEANUP_VERIFIED");
});

test("restoring fixtures reject duplicate file registration before state changes", () => {
  const child = runLifecycleFixture(`
const config = { value: "original-config" };
createTestState({ file: import.meta.path, config });
test("duplicate registration fails before either config is touched", () => {
  const otherConfig = { value: "other-original" };
  expect(() => createTestState({ file: import.meta.path, config: otherConfig }))
    .toThrow("Register one test state fixture per file: " + import.meta.path);
  expect(config.value).toBe("original-config");
  expect(otherConfig.value).toBe("other-original");
  expect(process.env[existingKey]).toBe("original-env");
  expect(process.env[absentKey]).toBeUndefined();
  console.log("DUPLICATE_REGISTRATION_REJECTED");
});
`);
  expect(child.exitCode, child.output).toBe(0);
  expect(child.output).toContain("DUPLICATE_REGISTRATION_REJECTED");
});

test("restoring fixtures clean each file before the next file reuses the helper module", () => {
  const child = runLifecycleFixture([
    `
const state = createTestState({ file: import.meta.path, config: shared.config });
state.setEnv(existingKey, "first-file-env");
state.setEnv(absentKey, "first-file-created-env");
state.setConfig("value", "first-file-config");
afterAll(() => {
  expect(shared.config.value).toBe("original-config");
  expect(process.env[existingKey]).toBe("original-env");
  expect(process.env[absentKey]).toBeUndefined();
  shared.completedFiles += 1;
  console.log("FIRST_FILE_CLEANUP_VERIFIED");
});
test("first file owns its top-level defaults", () => {
  expect(shared.config.value).toBe("first-file-config");
  expect(process.env[existingKey]).toBe("first-file-env");
  state.setConfig("value", "first-test-config");
});
`,
    `
expect(shared.completedFiles).toBe(1);
expect(shared.config.value).toBe("original-config");
expect(process.env[existingKey]).toBe("original-env");
expect(process.env[absentKey]).toBeUndefined();
const state = createTestState({ file: import.meta.path, config: shared.config });
afterEach(() => {
  expect(shared.config.value).toBe("original-config");
  expect(process.env[existingKey]).toBe("original-env");
  expect(process.env[absentKey]).toBeUndefined();
  console.log("SECOND_TEST_CLEANUP_VERIFIED");
});
afterAll(() => {
  expect(shared.config.value).toBe("original-config");
  shared.completedFiles += 1;
  expect(shared.completedFiles).toBe(2);
  console.log("SECOND_FILE_CLEANUP_VERIFIED");
});
test("second file registers hooks even though the helper module is cached", () => {
  expect(shared.completedFiles).toBe(1);
  expect(shared.config.value).toBe("original-config");
  state.setConfig("value", "second-test-config");
  state.setEnv(existingKey, "second-test-env");
  state.setEnv(absentKey, "second-test-created-env");
});
`,
  ]);
  expect(child.exitCode, child.output).toBe(0);
  expect(child.output).toContain("FIRST_FILE_CLEANUP_VERIFIED");
  expect(child.output).toContain("SECOND_TEST_CLEANUP_VERIFIED");
  expect(child.output).toContain("SECOND_FILE_CLEANUP_VERIFIED");
  expect(child.output).toContain("2 pass");
});
