import { Result, TaggedError } from "better-result";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { sha256Hex } from "@stll/sha256/node";

import { GITLEAKS_SHA256, GITLEAKS_VERSION } from "./gitleaks-pins";

class GitleaksProvisionError extends TaggedError("GitleaksProvisionError")<{
  message: string;
  cause?: unknown;
}> {}

const hasPinnedVersion = (binary: string) => {
  const result = Bun.spawnSync([binary, "version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return (
    result.exitCode === 0 &&
    result.stdout.toString().trim() === GITLEAKS_VERSION
  );
};

const downloadArchive = async (url: string) => {
  const response = Bun.spawnSync(
    [
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-time",
      "120",
      "--max-filesize",
      "67108864",
      url,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", maxBuffer: 67_108_864 },
  );
  if (response.exitCode !== 0) {
    throw new GitleaksProvisionError({
      message: `download failed: ${response.stderr.toString().trim()}`,
    });
  }
  return new Uint8Array(response.stdout);
};

type ResolveGitleaksOptions = {
  platform?: string;
  arch?: string;
  cacheHome?: string;
  pathBinary?: string | null;
  download?: typeof downloadArchive;
  // Tests supply a local fixture archive and its digest; the hook always uses repo pins.
  checksums?: Readonly<Record<keyof typeof GITLEAKS_SHA256, string>>;
};

/** Cached archives are reverified; extracted executables are never trusted on their own. */
export const resolveGitleaks = async ({
  platform = process.platform,
  arch = process.arch,
  cacheHome = process.env["XDG_CACHE_HOME"] || path.join(homedir(), ".cache"),
  pathBinary = Bun.which("gitleaks"),
  download = downloadArchive,
  checksums = GITLEAKS_SHA256,
}: ResolveGitleaksOptions = {}) =>
  Result.tryPromise({
    try: async () => {
      if (
        (platform !== "linux" && platform !== "darwin") ||
        (arch !== "x64" && arch !== "arm64")
      ) {
        throw new GitleaksProvisionError({
          message: `unsupported gitleaks platform ${platform}/${arch}`,
        });
      }
      if (pathBinary !== null && hasPinnedVersion(pathBinary)) {
        return pathBinary;
      }
      const digest = checksums[`${platform}-${arch}`];
      const cache = path.join(
        cacheHome,
        "stella",
        "gitleaks",
        GITLEAKS_VERSION,
        `${platform}-${arch}`,
      );
      mkdirSync(cache, { recursive: true, mode: 0o700 });
      const scratch = mkdtempSync(path.join(cache, ".provision-"));
      const archive = path.join(cache, "archive.tar.gz");
      try {
        const name = `gitleaks_${GITLEAKS_VERSION}_${platform}_${arch}.tar.gz`;
        const bytes = existsSync(archive)
          ? readFileSync(archive)
          : await download(
              `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${name}`,
            );
        if (sha256Hex(bytes) !== digest) {
          throw new GitleaksProvisionError({
            message: `checksum mismatch for ${name}; remove ${archive} and retry`,
          });
        }
        const verifiedArchive = path.join(scratch, "archive.tar.gz");
        writeFileSync(verifiedArchive, bytes, { mode: 0o600 });
        // Only this member is read, to stdout: archive paths cannot write files.
        const extracted = Bun.spawnSync(
          ["tar", "-xOzf", verifiedArchive, "gitleaks"],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        if (extracted.exitCode !== 0 || extracted.stdout.length === 0) {
          throw new GitleaksProvisionError({
            message: `cannot extract gitleaks from ${name}`,
          });
        }
        const binary = path.join(scratch, "gitleaks");
        writeFileSync(binary, extracted.stdout, { mode: 0o700 });
        if (!hasPinnedVersion(binary)) {
          throw new GitleaksProvisionError({
            message: `provisioned gitleaks does not report version ${GITLEAKS_VERSION}`,
          });
        }
        // Publish only complete, verified files; parallel hooks use independent scratch dirs.
        renameSync(verifiedArchive, archive);
        const cachedBinary = path.join(cache, "gitleaks");
        renameSync(binary, cachedBinary);
        return cachedBinary;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    catch: (cause) =>
      new GitleaksProvisionError({
        message: `cannot provision gitleaks ${GITLEAKS_VERSION}: ${String(cause)}`,
        cause,
      }),
  });

if (import.meta.main) {
  const result = await resolveGitleaks();
  if (result.isErr()) {
    console.error(`error: ${result.error.message}; secret scanning refused.`);
    process.exit(1);
  }
  console.log(result.value);
}
