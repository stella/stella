// Keeps a simulator's or emulator's development client in step with the
// checkout, rebuilding only when the native fingerprint moved.
//
//   bun scripts/native-client.ts check  <ios|android> <device>
//   bun scripts/native-client.ts ensure <ios|android> <device>
//
// `check` changes nothing: exit 0 means the installed client fits this
// checkout, 2 means a build is needed, 1 an operational error. `ensure`
// builds and installs when needed, then records what it built. A client
// installed some other way is "unknown" until `ensure` builds it once,
// because nothing proves which native inputs it was built from.

import { Result } from "better-result";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";
import { sha256Hex } from "@stll/sha256/bun";

import { isNativePlatform, nativeFingerprint } from "./fingerprint";
import type { NativePlatform } from "./fingerprint";

const APP_ROOT = path.resolve(import.meta.dir, "..");
const RECORD_DIR = path.join(APP_ROOT, ".cache", "native-client");

/** The development build's identity (`app.config.ts`). */
const DEVELOPMENT_IDENTIFIER = "app.stll.mobile.dev";

const recordSchema = v.object({
  fingerprint: v.pipe(v.string(), v.minLength(1)),
  binary: v.pipe(v.string(), v.minLength(1)),
});

export type NativeClientRecord = v.InferOutput<typeof recordSchema>;

export type NativeClientStatus = "compatible" | "missing" | "unknown" | "stale";

/**
 * Whether the installed client fits the checkout. The record ties a
 * fingerprint to the exact binary that `ensure` installed, so a client
 * reinstalled from elsewhere reads as unknown, never as compatible.
 */
export const clientStatus = (
  fingerprint: string,
  binary: string | null,
  record: NativeClientRecord | null,
): NativeClientStatus => {
  if (binary === null) {
    return "missing";
  }
  if (record === null || record.binary !== binary) {
    return "unknown";
  }
  return record.fingerprint === fingerprint ? "compatible" : "stale";
};

const run = async (command: readonly string[]) => {
  const handle = Bun.spawn([...command], {
    cwd: APP_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(handle.stdout).text(),
    new Response(handle.stderr).text(),
    handle.exited,
  ]);
  return { exitCode: childExitStatus(handle), stdout: stdout.trim() };
};

/** An identity for the installed build that changes whenever it is reinstalled. */
const installedBinary = async (
  platform: NativePlatform,
  device: string,
): Promise<string | null> => {
  if (platform === "ios") {
    const container = await run([
      "xcrun",
      "simctl",
      "get_app_container",
      device,
      DEVELOPMENT_IDENTIFIER,
      "app",
    ]);
    if (container.exitCode !== 0 || container.stdout === "") {
      return null;
    }
    const executable = await run([
      "plutil",
      "-extract",
      "CFBundleExecutable",
      "raw",
      path.join(container.stdout, "Info.plist"),
    ]);
    return executable.exitCode === 0
      ? sha256Hex(readFileSync(path.join(container.stdout, executable.stdout)))
      : null;
  }
  const packageInfo = await run([
    "adb",
    "-s",
    device,
    "shell",
    "dumpsys",
    "package",
    DEVELOPMENT_IDENTIFIER,
  ]);
  const installed = packageInfo.stdout.match(/lastUpdateTime=(.+)/u)?.[1];
  return packageInfo.exitCode === 0 && installed !== undefined
    ? sha256Hex(`${DEVELOPMENT_IDENTIFIER}@${installed.trim()}`)
    : null;
};

const recordPath = (platform: NativePlatform, device: string) =>
  path.join(RECORD_DIR, `${platform}-${sha256Hex(device).slice(0, 16)}.json`);

const readRecord = (
  platform: NativePlatform,
  device: string,
): NativeClientRecord | null => {
  const stored = Result.try(() =>
    readFileSync(recordPath(platform, device), "utf-8"),
  );
  if (Result.isError(stored)) {
    return null;
  }
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), recordSchema),
    stored.value,
  );
  return parsed.success ? parsed.output : null;
};

const build = async (platform: NativePlatform, device: string) => {
  const handle = Bun.spawn(
    ["bunx", "expo", `run:${platform}`, "--device", device, "--no-bundler"],
    {
      cwd: APP_ROOT,
      env: { ...process.env, APP_VARIANT: "development" },
      stderr: "inherit",
      stdout: "inherit",
    },
  );
  await handle.exited;
  return childExitStatus(handle);
};

const main = async (): Promise<number> => {
  const [mode, platform = "", device = ""] = process.argv.slice(2);
  if (
    (mode !== "check" && mode !== "ensure") ||
    !isNativePlatform(platform) ||
    device === ""
  ) {
    process.stderr.write(
      "usage: bun scripts/native-client.ts <check|ensure> <ios|android> <device>\n",
    );
    return 1;
  }
  process.env["APP_VARIANT"] = "development";
  const fingerprint = await nativeFingerprint(platform);
  const status = clientStatus(
    fingerprint,
    await installedBinary(platform, device),
    readRecord(platform, device),
  );
  process.stdout.write(`${platform} development client: ${status}\n`);
  if (status === "compatible") {
    return 0;
  }
  if (mode === "check") {
    return 2;
  }
  const exitCode = await build(platform, device);
  if (exitCode !== 0) {
    return exitCode;
  }
  // The checkout must not have moved while the build ran, or the record
  // would vouch for inputs the binary was not built from.
  if ((await nativeFingerprint(platform)) !== fingerprint) {
    process.stderr.write(
      "Native inputs changed during the build; run ensure again. Nothing was recorded.\n",
    );
    return 1;
  }
  const binary = await installedBinary(platform, device);
  if (binary === null) {
    process.stderr.write(
      "The build finished but no development client is installed.\n",
    );
    return 1;
  }
  mkdirSync(RECORD_DIR, { recursive: true });
  writeFileSync(
    recordPath(platform, device),
    `${JSON.stringify({ fingerprint, binary } satisfies NativeClientRecord)}\n`,
  );
  return 0;
};

if (import.meta.main) {
  process.exit(await main());
}
