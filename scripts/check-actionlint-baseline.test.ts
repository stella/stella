import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dir, "check-actionlint-baseline.ts");
const FINDING = {
  filepath: ".github/workflows/example.yml",
  kind: "syntax-check",
  message: "unexpected key",
};

type FixtureOptions = {
  status: number;
  findings?: unknown;
  args?: string[];
};

const runFixture = ({ status, findings = [], args = [] }: FixtureOptions) => {
  const root = mkdtempSync(path.join(tmpdir(), "actionlint-check-"));
  try {
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".github/workflows/example.yml"),
      "jobs: {}\n",
    );
    const binary = path.join(root, "fake-actionlint");
    writeFileSync(
      binary,
      `#!/bin/sh\n[ "$#" -eq 5 ] && [ "$1" = '-format' ] && [ "$2" = '{{json .}}' ] && [ "$3" = '-stdin-filename' ] && [ "$4" = '.github/workflows/example.yml' ] && [ "$5" = '-' ] || exit 99\ncat >/dev/null\ncat <<'JSON'\n${JSON.stringify(findings)}\nJSON\nexit ${status}\n`,
    );
    chmodSync(binary, 0o755);
    const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
      cwd: root,
      env: { ...process.env, ACTIONLINT_BIN: binary },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

for (const status of [0, 1]) {
  test(`zero findings pass with actionlint status ${status}`, () => {
    const result = runFixture({ status, findings: [] });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test(`any finding fails with actionlint status ${status}`, () => {
    const result = runFixture({
      status,
      findings: [FINDING, FINDING, { ...FINDING, message: "new finding" }],
      args: ["--check"],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("actionlint reported 2 finding group(s):");
    expect(result.stderr).toContain('"count": 2');
    expect(result.stderr).toContain('"message": "new finding"');
  });
}

test("actionlint status 3 fails as a tool error", () => {
  const result = runFixture({ status: 3 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("actionlint exited with status 3");
});

test("unknown arguments fail with usage error", () => {
  const result = runFixture({ status: 0, args: ["--write"] });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Usage: bun scripts/check-actionlint-baseline.ts [--check]",
  );
});

test("malformed findings fail instead of silently passing", () => {
  const result = runFixture({
    status: 0,
    findings: [{ kind: "syntax-check" }],
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "actionlint output must be an array of findings",
  );
});
