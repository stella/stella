import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const script = path.join(root, "scripts/cloud-env-secret-scanner-setup.sh");

const assignment = (source: string, name: string) => {
  const match = new RegExp(`^${name}=(\\S+)$`, "mu").exec(source);
  if (!match?.[1]) {
    throw new Error(`${name} is not assigned in ${script}`);
  }
  return match[1];
};

const generatedSha = (source: string, version: string, arch: string) => {
  const archive = `gitleaks_${version}_linux_${arch}.tar.gz`;
  const match = new RegExp(
    `${archive.replaceAll(".", "\\.")}'; artifact_sha='([0-9a-f]{64})'`,
    "u",
  ).exec(source);
  if (!match?.[1]) {
    throw new Error(`.agents/cloud-setup.sh pins no checksum for ${archive}`);
  }
  return match[1];
};

test("the setup script installs exactly the gitleaks the toolchain pins", async () => {
  const source = await readFile(script, "utf-8");
  const toolchain = JSON.parse(
    await readFile(path.join(root, "stll-toolchain.json"), "utf-8"),
  ) as { cloud: { tools: { gitleaks: string } } };
  const generated = await readFile(
    path.join(root, ".agents/cloud-setup.sh"),
    "utf-8",
  );

  const version = assignment(source, "VERSION");
  expect(version).toBe(toolchain.cloud.tools.gitleaks);
  expect(assignment(source, "SHA256_X64")).toBe(
    generatedSha(generated, version, "x64"),
  );
  expect(assignment(source, "SHA256_ARM64")).toBe(
    generatedSha(generated, version, "arm64"),
  );
});

// Stub commands come first on PATH: the script runs as "root" on x86_64, and
// curl either fails or writes an archive whose checksum cannot match.
const runWithStubs = async (curl: string) => {
  const bin = await mkdtemp(path.join(tmpdir(), "secret-scanner-setup-"));
  const stubs: Record<string, string> = {
    curl,
    id: "echo 0",
    uname: "echo x86_64",
    sha256sum:
      'echo "0000000000000000000000000000000000000000000000000000000000000000  $1"',
  };
  try {
    for (const [name, body] of Object.entries(stubs)) {
      const file = path.join(bin, name);
      await writeFile(file, `#!/bin/sh\n${body}\n`);
      await chmod(file, 0o755);
    }
    const result = Bun.spawnSync(["bash", script], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: result.exitCode, stderr: result.stderr.toString() };
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
};

test("a failed download never fails the environment", async () => {
  const result = await runWithStubs("exit 22");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("gitleaks NOT installed: download failed");
});

test("a checksum mismatch installs nothing and never fails the environment", async () => {
  const result = await runWithStubs(
    'while [ "$1" != "-o" ]; do shift; done; echo tampered > "$2"',
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain(
    "gitleaks NOT installed: checksum mismatch for gitleaks_",
  );
});
