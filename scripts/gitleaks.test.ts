import { afterAll, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex } from "@stll/sha256/node";

import { resolveGitleaks } from "./gitleaks";
import { GITLEAKS_SHA256, GITLEAKS_VERSION } from "./gitleaks-pins";

const root = mkdtempSync(path.join(tmpdir(), "gitleaks-provision-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
const run = (cwd: string, args: string[]) => {
  const result = Bun.spawnSync(args, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${args[0]} failed: ${result.stderr}`);
  }
  return result;
};

const fixture = (binary?: string) => {
  const dir = mkdtempSync(path.join(root, "case-"));
  if (binary) {
    copyFileSync(binary, path.join(dir, "gitleaks"));
  } else {
    writeFileSync(
      path.join(dir, "gitleaks"),
      `#!/bin/sh\necho ${GITLEAKS_VERSION}\n`,
      { mode: 0o700 },
    );
  }
  run(dir, ["tar", "-czf", "fixture.tar.gz", "gitleaks"]);
  const bytes = readFileSync(path.join(dir, "fixture.tar.gz"));
  const digest = sha256Hex(bytes);
  // Explicit keys keep the fixture coupled to the production platform set.
  return {
    dir,
    bytes,
    options: {
      cacheHome: dir,
      pathBinary: null,
      checksums: {
        "linux-x64": digest,
        "linux-arm64": digest,
        "darwin-x64": digest,
        "darwin-arm64": digest,
      },
    },
  };
};

const noNetwork = async () => {
  throw new Error("network must not be used");
};

test.each(Object.keys(GITLEAKS_SHA256))(
  "provisions %s and reuses its verified archive without network",
  async (key) => {
    const { dir, bytes, options } = fixture();
    const [platform, arch] = key.split("-");
    const calls: string[] = [];
    const result = await resolveGitleaks({
      ...options,
      platform,
      arch,
      download: async (url) => {
        calls.push(url);
        return bytes;
      },
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    expect(calls).toEqual([
      `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${platform}_${arch}.tar.gz`,
    ]);
    // A modified cached executable is replaced from the verified archive, never run.
    writeFileSync(
      result.value,
      `#!/bin/sh\ntouch "${path.join(dir, "unverified-ran")}"\n`,
    );
    const cached = await resolveGitleaks({
      ...options,
      platform,
      arch,
      download: noNetwork,
    });
    expect(cached.isOk()).toBe(true);
    expect(existsSync(path.join(dir, "unverified-ran"))).toBe(false);
    if (cached.isErr()) {
      throw cached.error;
    }
    expect(run(dir, [cached.value, "version"]).stdout.toString().trim()).toBe(
      GITLEAKS_VERSION,
    );
  },
);

test("a mismatched PATH version provisions the pinned scanner", async () => {
  const { dir, bytes, options } = fixture();
  const old = path.join(dir, "old");
  writeFileSync(old, "#!/bin/sh\necho 0.0.0\n", { mode: 0o700 });
  const result = await resolveGitleaks({
    ...options,
    pathBinary: old,
    download: async () => bytes,
  });
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw result.error;
  }
  expect(result.value).not.toBe(old);
});

test("a pinned PATH scanner needs neither cache nor network", async () => {
  const { dir, options } = fixture();
  const binary = path.join(dir, "gitleaks");
  const result = await resolveGitleaks({
    ...options,
    pathBinary: binary,
    download: noNetwork,
  });
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw result.error;
  }
  expect(result.value).toBe(binary);
  expect(existsSync(path.join(dir, "stella"))).toBe(false);
});

test("a checksum mismatch refuses before extraction or execution", async () => {
  const { bytes, options } = fixture();
  const result = await resolveGitleaks({
    ...options,
    checksums: GITLEAKS_SHA256,
    download: async () => bytes,
  });
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new Error("unverified archive accepted");
  }
  expect(result.error.message).toContain("checksum mismatch");
});

test("a corrupted cached archive refuses without network", async () => {
  const { options } = fixture();
  const cache = path.join(
    options.cacheHome,
    "stella",
    "gitleaks",
    GITLEAKS_VERSION,
    `${process.platform}-${process.arch}`,
  );
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "archive.tar.gz"), "corrupted");
  const result = await resolveGitleaks({ ...options, download: noNetwork });
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new Error("corrupted cache accepted");
  }
  expect(result.error.message).toContain("checksum mismatch");
});

test.each([
  { platform: "win32", arch: "x64" },
  { platform: "linux", arch: "riscv64" },
])("unknown platform refuses before network: %j", async (platform) => {
  const result = await resolveGitleaks({
    ...platform,
    pathBinary: null,
    download: noNetwork,
  });
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new Error("unknown platform accepted");
  }
  expect(result.error.message).toContain("unsupported gitleaks platform");
});

test("download failures refuse scanning", async () => {
  const { options } = fixture();
  const result = await resolveGitleaks({ ...options, download: noNetwork });
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new Error("failed download accepted");
  }
  expect(result.error.message).toContain("network must not be used");
});

test("a verified but malformed archive refuses scanning", async () => {
  const { options } = fixture();
  const bytes = Buffer.from("not a gzip archive");
  const digest = sha256Hex(bytes);
  const result = await resolveGitleaks({
    ...options,
    checksums: {
      "linux-x64": digest,
      "linux-arm64": digest,
      "darwin-x64": digest,
      "darwin-arm64": digest,
    },
    download: async () => bytes,
  });
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new Error("invalid archive accepted");
  }
  expect(result.error.message).toContain("cannot extract gitleaks");
});

const realScanner = Bun.which("gitleaks");
test.skipIf(realScanner === null)(
  "the provisioned real scanner finds a staged synthetic secret using a local archive",
  async () => {
    if (realScanner === null) {
      throw new Error("gitleaks fixture binary is unavailable");
    }
    const { dir, bytes, options } = fixture(realScanner);
    const result = await resolveGitleaks({
      ...options,
      download: async () => bytes,
    });
    if (result.isErr()) {
      throw result.error;
    }
    run(dir, ["git", "init", "-q"]);
    // Assemble a synthetic token shape; no credential is stored in this source.
    const secret = `ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6"}`;
    writeFileSync(path.join(dir, "secret.txt"), `token = "${secret}"\n`);
    run(dir, ["git", "add", "secret.txt"]);
    const scan = Bun.spawnSync(
      [process.execPath, path.join(import.meta.dir, "check-staged-secrets.ts")],
      {
        cwd: dir,
        env: {
          ...env,
          PATH: `${path.dirname(result.value)}:${env["PATH"] ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(scan.exitCode).toBe(1);
    expect(scan.stderr.toString()).toContain("leaks found");
  },
);
