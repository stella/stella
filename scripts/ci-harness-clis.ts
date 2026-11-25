#!/usr/bin/env bun
/**
 * Installs the agent CLIs `apps/desktop/src-tauri/harness/pins.json` pins,
 * for the agent engine's tests against a real CLI on a Linux CI runner:
 * Codex, as the single binary of its GitHub release at the pinned version,
 * checked against the SHA-256 digest GitHub reports for the asset.
 *
 * Usage: bun scripts/ci-harness-clis.ts <directory>
 *
 * The binary lands in `<directory>/codex-<version>/`, which a cache keyed on
 * the pins file keeps between runs (`.github/actions/harness-clis`); one
 * already there at the pinned version is kept. The folder then goes on
 * `GITHUB_PATH`, and `STELLA_REAL_HARNESS_CLIS` on `GITHUB_ENV` names what is
 * installed: the agent engine's tests read it to require the CLI, and Turbo
 * hashes it into their cache key. Nothing here signs in or reaches a model
 * provider.
 */

import { panic } from "better-result";
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { sha256Hex } from "../packages/sha256/src/bun";

const REPO_ROOT = path.join(import.meta.dir, "..");
const PINS_PATH = path.join(
  REPO_ROOT,
  "apps/desktop/src-tauri/harness/pins.json",
);
const CODEX_RELEASES = "https://api.github.com/repos/openai/codex/releases";
const FETCH_TIMEOUT_MS = 120_000;
const FETCH_ATTEMPTS = 3;

/** The Linux targets Codex publishes a static binary for, by Node's arch. */
const LINUX_TARGETS: Readonly<Record<string, string>> = {
  x64: "x86_64-unknown-linux-musl",
  arm64: "aarch64-unknown-linux-musl",
};

const fail = (message: string): never => panic(message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The pinned Codex version from the pins file's contents. */
export const pinnedCodexVersion = (pins: unknown): string => {
  const version = isRecord(pins) ? pins["codex"] : undefined;
  return typeof version === "string" && /^\d+\.\d+\.\d+/u.test(version)
    ? version
    : fail("pins.json names no Codex version");
};

/** The release asset holding the Codex binary for `arch`, zstd-compressed. */
export const codexAssetName = (arch: string): string => {
  const target = Object.hasOwn(LINUX_TARGETS, arch)
    ? LINUX_TARGETS[arch]
    : undefined;
  return target === undefined
    ? fail(`No Codex binary is published for linux-${arch}`)
    : `codex-${target}.zst`;
};

/** The download URL and SHA-256 of asset `name` in a GitHub release. */
export const releaseAsset = (
  release: unknown,
  name: string,
): { url: string; sha256: string } => {
  const assets =
    isRecord(release) && Array.isArray(release["assets"])
      ? release["assets"]
      : [];
  const asset = assets.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate["name"] === name,
  );
  const url = asset?.["browser_download_url"];
  const digest = asset?.["digest"];
  const sha256 =
    typeof digest === "string"
      ? /^sha256:([0-9a-f]{64})$/u.exec(digest)?.[1]
      : undefined;
  if (typeof url !== "string" || sha256 === undefined) {
    return fail(`The release has no ${name} asset with a SHA-256 digest`);
  }
  return { url, sha256 };
};

/** The version a `codex --version` line names, else `null`. */
export const codexVersionOf = (output: string): string | null =>
  /^codex-cli (\S+)$/mu.exec(output.trim())?.[1] ?? null;

const fetchWithRetry = async (
  url: string,
  headers: Record<string, string>,
): Promise<Response> => {
  for (let attempt = 1; ; attempt += 1) {
    // oxlint-disable-next-line require-polite-publisher-fetch/require-polite-publisher-fetch -- release metadata and the release binary, not publisher content; two requests per cache miss
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch((error: unknown) =>
      attempt >= FETCH_ATTEMPTS ? Promise.reject(error) : null,
    );
    if (response?.ok === true) {
      return response;
    }
    if (attempt >= FETCH_ATTEMPTS) {
      return fail(
        `GET ${url} failed: ${String(response?.status ?? "no response")}`,
      );
    }
    await Bun.sleep(attempt * 2000);
  }
};

const installedVersion = (binary: string): string | null => {
  if (!existsSync(binary)) {
    return null;
  }
  const ran = Bun.spawnSync([binary, "--version"]);
  return ran.exitCode === 0 ? codexVersionOf(ran.stdout.toString()) : null;
};

const installCodex = async (version: string, directory: string) => {
  const folder = path.join(directory, `codex-${version}`);
  const binary = path.join(folder, "codex");
  if (installedVersion(binary) === version) {
    console.log(`Codex ${version} restored from the cache`);
    return folder;
  }
  const token = process.env["GITHUB_TOKEN"] ?? "";
  const release: unknown = await (
    await fetchWithRetry(`${CODEX_RELEASES}/tags/rust-v${version}`, {
      accept: "application/vnd.github+json",
      ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
    })
  ).json();
  const name = codexAssetName(process.arch);
  const { url, sha256 } = releaseAsset(release, name);
  const archive = new Uint8Array(
    await (await fetchWithRetry(url, {})).arrayBuffer(),
  );
  const actual = sha256Hex(archive);
  if (actual !== sha256) {
    fail(`${name} has SHA-256 ${actual}, not the published ${sha256}`);
  }
  mkdirSync(folder, { recursive: true });
  const compressed = `${binary}.zst`;
  await Bun.write(compressed, archive);
  const unpacked = Bun.spawnSync([
    "zstd",
    "-d",
    "-f",
    "-q",
    compressed,
    "-o",
    binary,
  ]);
  if (unpacked.exitCode !== 0) {
    fail(`zstd could not unpack ${name}: ${unpacked.stderr.toString()}`);
  }
  await Bun.file(compressed).delete();
  chmodSync(binary, 0o755);
  if (installedVersion(binary) !== version) {
    fail(`The unpacked binary is not Codex ${version}`);
  }
  console.log(`Codex ${version} installed from ${name}`);
  return folder;
};

if (import.meta.main) {
  const directory =
    process.argv[2] ??
    fail("Usage: bun scripts/ci-harness-clis.ts <directory>");
  if (process.platform !== "linux") {
    fail("The harness CLIs are installed for Linux CI runners only");
  }
  const version = pinnedCodexVersion(await Bun.file(PINS_PATH).json());
  const folder = await installCodex(version, path.resolve(directory));
  const githubPath = process.env["GITHUB_PATH"];
  const githubEnv = process.env["GITHUB_ENV"];
  if (githubPath !== undefined && githubEnv !== undefined) {
    appendFileSync(githubPath, `${folder}\n`);
    appendFileSync(githubEnv, `STELLA_REAL_HARNESS_CLIS=codex@${version}\n`);
  }
}
