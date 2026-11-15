#!/usr/bin/env bun
/**
 * Regenerates `apps/desktop/src-tauri/harness/releases.gen.json`, the
 * per-platform download table of the agent CLIs and tools Stella Desktop
 * installs, from the versions pinned in
 * `apps/desktop/src-tauri/harness/pins.json`.
 *
 * - Codex: the `codex-package-<target>.tar.gz` asset of the OpenAI GitHub
 *   release, with the SHA-256 digest and byte size GitHub reports for it.
 * - Claude Code: the native platform package of the Claude Agent SDK on npm
 *   (`@anthropic-ai/claude-agent-sdk-<os>-<cpu>`) at the pinned SDK version,
 *   with the registry's SHA-512 integrity and the tarball's byte size. The
 *   CLI version the probe expects is the SDK's `claudeCodeVersion`.
 * - Bun: its native platform package on npm (`@oven/bun-<os>-<cpu>`) at the
 *   pinned version, with the registry's SHA-512 integrity and the tarball's
 *   byte size. x64 takes the baseline build, which also runs on CPUs without
 *   AVX2.
 *
 * Digests come only from upstream metadata; never edit the table by hand.
 * The desktop crate's tests bind the table to the pins file.
 *
 * Modes:
 *   (default)   regenerate and compare with the committed file; exit 1 on drift
 *   --write     overwrite the committed file
 *
 * A manual upgrade tool, outside the build and outside CI: it reads upstream
 * metadata over the network. `GITHUB_TOKEN`, when set, authenticates the one
 * GitHub API request.
 */

import { panic } from "better-result";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import {
  formattedLikeRepository,
  writeOrCheckArtifacts,
} from "./generated-artifacts";

const REPO_ROOT = path.join(import.meta.dir, "..");
const HARNESS_DIR = path.join(REPO_ROOT, "apps/desktop/src-tauri/harness");
const PINS_PATH = path.join(HARNESS_DIR, "pins.json");
const TABLE_PATH = path.join(HARNESS_DIR, "releases.gen.json");

const CODEX_REPOSITORY = "openai/codex";
const NPM_REGISTRY = "https://registry.npmjs.org";
const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const BUN_SCOPE = "@oven";

/** The platforms Stella Desktop ships for, in npm's `<os>-<cpu>` naming. */
const PLATFORMS = {
  "darwin-arm64": { target: "aarch64-apple-darwin", exe: "" },
  "darwin-x64": { target: "x86_64-apple-darwin", exe: "" },
  "win32-arm64": { target: "aarch64-pc-windows-msvc", exe: ".exe" },
  "win32-x64": { target: "x86_64-pc-windows-msvc", exe: ".exe" },
} as const satisfies Record<string, { target: string; exe: "" | ".exe" }>;

type Platform = keyof typeof PLATFORMS;
const platforms = (): Platform[] =>
  Object.keys(PLATFORMS).filter((key): key is Platform => key in PLATFORMS);

/** A value for every platform; the literal fails to compile if one is missing. */
const byPlatform = <T>(
  make: (platform: Platform) => T,
): Record<Platform, T> => ({
  "darwin-arm64": make("darwin-arm64"),
  "darwin-x64": make("darwin-x64"),
  "win32-arm64": make("win32-arm64"),
  "win32-x64": make("win32-x64"),
});

const versionSchema = v.pipe(
  v.string(),
  v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
);

const pinsSchema = v.strictObject({
  codex: versionSchema,
  claudeAgentSdk: versionSchema,
  bun: versionSchema,
});

const githubReleaseSchema = v.object({
  tag_name: v.string(),
  draft: v.literal(false),
  prerelease: v.literal(false),
  assets: v.array(
    v.object({
      name: v.string(),
      size: v.pipe(v.number(), v.integer(), v.minValue(1)),
      digest: v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/u)),
      browser_download_url: v.string(),
    }),
  ),
});

const sdkVersionSchema = v.object({
  version: versionSchema,
  claudeCodeVersion: versionSchema,
  optionalDependencies: v.record(v.string(), v.string()),
});

const platformPackageSchema = v.object({
  name: v.string(),
  version: versionSchema,
  dist: v.object({
    tarball: v.string(),
    integrity: v.pipe(v.string(), v.regex(/^sha512-[A-Za-z0-9+/]{86}==$/u)),
  }),
});

type Digest = { sha256: string } | { sha512: string };

type Asset = {
  url: string;
  digest: Digest;
  archiveBytes: number;
  target: string;
  executable: string;
};

type Release = { version: string; assets: Record<Platform, Asset> };

/** The one HTTP call: registry and release metadata, read once per pin bump. */
const get = async (
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<Response> =>
  // oxlint-disable-next-line require-polite-publisher-fetch/require-polite-publisher-fetch -- package registry and release metadata, not publisher content; a manual tool making ten requests per pin bump
  await fetch(url, { headers });

const fetchJson = async (
  url: string,
  headers: Readonly<Record<string, string>> = {},
) => {
  const response = await get(url, headers);
  if (!response.ok) {
    return panic(`GET ${url} answered ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  return body;
};

/**
 * The registry answers HEAD without a length, so the size comes from the
 * total in a one-byte range response.
 */
const archiveBytes = async (url: string): Promise<number> => {
  const response = await get(url, { range: "bytes=0-0" });
  await response.body?.cancel();
  const total = Number(
    /^bytes 0-0\/(\d+)$/u.exec(
      response.headers.get("content-range") ?? "",
    )?.[1],
  );
  if (response.status !== 206 || !Number.isSafeInteger(total) || total <= 0) {
    return panic(`${url} reported no usable size`);
  }
  return total;
};

const requireUrl = (url: string, prefix: string): string =>
  url.startsWith(prefix) ? url : panic(`${url} is not under ${prefix}`);

/** npm integrity is base64; the table stores every digest as lowercase hex. */
const integrityHex = (integrity: string): string =>
  Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");

const codexRelease = async (version: string): Promise<Release> => {
  const tag = `rust-v${version}`;
  const token = process.env["GITHUB_TOKEN"];
  const release = v.parse(
    githubReleaseSchema,
    await fetchJson(
      `https://api.github.com/repos/${CODEX_REPOSITORY}/releases/tags/${tag}`,
      {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    ),
  );
  const downloads = `https://github.com/${CODEX_REPOSITORY}/releases/download/${tag}/`;
  const asset = (platform: Platform): Asset => {
    const { exe, target } = PLATFORMS[platform];
    const name = `codex-package-${target}.tar.gz`;
    const found =
      release.assets.find((candidate) => candidate.name === name) ??
      panic(`${tag} has no ${name}`);
    return {
      url: requireUrl(found.browser_download_url, downloads),
      digest: { sha256: found.digest.slice("sha256:".length) },
      archiveBytes: found.size,
      target,
      executable: `bin/codex${exe}`,
    };
  };
  return { version, assets: byPlatform(asset) };
};

/** An npm package's tarball as an asset, by the registry's own metadata. */
const npmAsset = async ({
  name,
  version,
  platform,
  executable,
}: {
  name: string;
  version: string;
  platform: Platform;
  executable: string;
}): Promise<Asset> => {
  const metadata = v.parse(
    platformPackageSchema,
    await fetchJson(`${NPM_REGISTRY}/${name}/${version}`),
  );
  if (metadata.name !== name || metadata.version !== version) {
    return panic(`${name}@${version} metadata names another package`);
  }
  const url = requireUrl(metadata.dist.tarball, `${NPM_REGISTRY}/${name}/-/`);
  return {
    url,
    digest: { sha512: integrityHex(metadata.dist.integrity) },
    archiveBytes: await archiveBytes(url),
    target: PLATFORMS[platform].target,
    executable,
  };
};

/** A value per platform, fetched concurrently. */
const fetchByPlatform = async (
  fetchAsset: (platform: Platform) => Promise<Asset>,
): Promise<Record<Platform, Asset>> => {
  const fetched = new Map(
    await Promise.all(
      platforms().map(
        async (platform) => [platform, await fetchAsset(platform)] as const,
      ),
    ),
  );
  return byPlatform(
    (platform) => fetched.get(platform) ?? panic(`${platform} was not fetched`),
  );
};

const claudeRelease = async (sdkVersion: string): Promise<Release> => {
  const sdk = v.parse(
    sdkVersionSchema,
    await fetchJson(`${NPM_REGISTRY}/${CLAUDE_SDK_PACKAGE}/${sdkVersion}`),
  );
  const asset = async (platform: Platform): Promise<Asset> => {
    const name = `${CLAUDE_SDK_PACKAGE}-${platform}`;
    if (sdk.optionalDependencies[name] !== sdkVersion) {
      return panic(`${CLAUDE_SDK_PACKAGE}@${sdkVersion} does not pin ${name}`);
    }
    return await npmAsset({
      name,
      version: sdkVersion,
      platform,
      executable: `package/claude${PLATFORMS[platform].exe}`,
    });
  };
  return {
    version: sdk.claudeCodeVersion,
    assets: await fetchByPlatform(asset),
  };
};

/** Bun's npm name per platform; x64 takes the baseline build. */
const BUN_PACKAGES = {
  "darwin-arm64": "bun-darwin-aarch64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "win32-arm64": "bun-windows-aarch64",
  "win32-x64": "bun-windows-x64-baseline",
} as const satisfies Record<Platform, string>;

const bunRelease = async (version: string): Promise<Release> => ({
  version,
  assets: await fetchByPlatform(
    async (platform) =>
      await npmAsset({
        name: `${BUN_SCOPE}/${BUN_PACKAGES[platform]}`,
        version,
        platform,
        executable: `package/bin/bun${PLATFORMS[platform].exe}`,
      }),
  ),
});

const main = async (): Promise<number> => {
  const write = process.argv.includes("--write");
  const pins = v.parse(
    pinsSchema,
    JSON.parse(await readFile(PINS_PATH, "utf-8")),
  );
  const [codex, claudeCode, bun] = await Promise.all([
    codexRelease(pins.codex),
    claudeRelease(pins.claudeAgentSdk),
    bunRelease(pins.bun),
  ]);
  const table = {
    pins,
    harnesses: { codex, "claude-code": claudeCode },
    tools: { bun },
  };
  return await writeOrCheckArtifacts(
    [
      {
        path: TABLE_PATH,
        contents: await formattedLikeRepository(
          `${JSON.stringify(table, null, 2)}\n`,
          "json",
        ),
      },
    ],
    { write, matched: "the pinned upstream releases" },
  );
};

process.exit(await main());
