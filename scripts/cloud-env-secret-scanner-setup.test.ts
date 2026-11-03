import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import toolchain from "../stll-toolchain.json" with { type: "json" };
import { GITLEAKS_SHA256, GITLEAKS_VERSION } from "./gitleaks-pins";

const root = path.resolve(import.meta.dir, "..");
const script = path.join(root, "scripts/cloud-env-secret-scanner-setup.sh");

test("cloud setup pins agree with the scanner provisioner", async () => {
  expect(toolchain.cloud.tools.gitleaks).toBe(GITLEAKS_VERSION);
  const generated = await readFile(
    path.join(root, ".agents/cloud-setup.sh"),
    "utf-8",
  );
  for (const arch of ["x64", "arm64"] as const) {
    expect(generated).toContain(
      `gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz'; artifact_sha='${GITLEAKS_SHA256[`linux-${arch}`]}'`,
    );
  }
});

type StubOptions = { provision: string; install?: string };

const runWithStubs = async ({ provision, install = "exit 0" }: StubOptions) => {
  const bin = await mkdtemp(path.join(tmpdir(), "secret-scanner-setup-"));
  const log = path.join(bin, "install.log");
  const scanner = path.join(bin, "verified-gitleaks");
  const stubs: Record<string, string> = {
    bun: provision.replaceAll("SCANNER_PATH", () => scanner),
    id: "echo 0",
    install: `echo "$*" >> '${log}'\n${install}`,
    "verified-gitleaks": "exit 0",
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
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      installs: (await Bun.file(log).exists())
        ? await readFile(log, "utf-8")
        : "",
      scanner,
    };
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
};

test("a provisioning failure installs nothing and keeps the environment usable", async () => {
  const result = await runWithStubs({ provision: "exit 1" });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(
    "gitleaks NOT installed: provisioning failed",
  );
  expect(result.installs).toBe("");
});

test("an invalid provisioner result installs nothing", async () => {
  const result = await runWithStubs({ provision: "echo /missing/scanner" });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("provisioner returned no executable");
  expect(result.installs).toBe("");
});

test("setup installs the executable returned by the shared provisioner", async () => {
  const result = await runWithStubs({ provision: "echo SCANNER_PATH" });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(
    "gitleaks installed at /usr/local/bin/gitleaks",
  );
  expect(result.installs).toContain(
    `-m 755 ${result.scanner} /usr/local/bin/gitleaks`,
  );
});

test("an installation failure keeps the environment usable", async () => {
  const result = await runWithStubs({
    provision: "echo SCANNER_PATH",
    install: "exit 1",
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(
    "gitleaks NOT installed: cannot create /usr/local/bin",
  );
});
