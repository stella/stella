import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BASELINE_PATHS } from "./baseline-paths.ts";

const SCRIPT = path.join(import.meta.dir, "check-actionlint-baseline.ts");
const FINDING = {
  filepath: ".github/workflows/example.yml",
  kind: "syntax-check",
  message: "unexpected key",
};
const BASELINE = [{ count: 2, ...FINDING }];

type FixtureOptions = {
  status: number;
  findings?: unknown;
  baseline?: unknown;
  args?: string[];
};

const runFixture = ({
  status,
  findings = [FINDING, FINDING],
  baseline = BASELINE,
  args = [],
}: FixtureOptions) => {
  const root = mkdtempSync(path.join(tmpdir(), "actionlint-baseline-"));
  try {
    const baselinePath = path.join(root, BASELINE_PATHS.actionlint);
    mkdirSync(path.dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    const binary = path.join(root, "fake-actionlint");
    writeFileSync(
      binary,
      `#!/bin/sh\n[ "$#" -eq 2 ] && [ "$1" = '-format' ] && [ "$2" = '{{json .}}' ] || exit 99\ncat <<'JSON'\n${JSON.stringify(findings)}\nJSON\nexit ${status}\n`,
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
      baseline: readFileSync(baselinePath, "utf-8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

for (const status of [0, 1]) {
  test(`findings equal to the baseline pass with actionlint status ${status}`, () => {
    const result = runFixture({ status });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test(`new findings fail comparison with actionlint status ${status}`, () => {
    const result = runFixture({
      status,
      findings: [FINDING, FINDING, { ...FINDING, message: "new finding" }],
      args: ["--check"],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`--- ${BASELINE_PATHS.actionlint}`);
    expect(result.stderr).toContain("+++ actionlint actual");
    expect(result.stderr).toContain('+    "message": "new finding"');
    expect(result.baseline).toBe(`${JSON.stringify(BASELINE, null, 2)}\n`);
  });
}

test("removed findings fail comparison", () => {
  const result = runFixture({ status: 0, findings: [FINDING] });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('-    "count": 2');
  expect(result.stderr).toContain('+    "count": 1');
});

for (const args of [[], ["--write"]]) {
  test(`actionlint status 3 fails before comparing or writing (${args.at(0) ?? "default"})`, () => {
    const result = runFixture({ status: 3, args });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("actionlint exited with status 3");
    expect(result.baseline).toBe(`${JSON.stringify(BASELINE, null, 2)}\n`);
  });
}

test("--write groups counts and sorts by filepath, kind, and message", () => {
  const earlier = { ...FINDING, filepath: ".github/workflows/a.yml" };
  const otherKind = { ...FINDING, kind: "expression" };
  const otherMessage = { ...FINDING, message: "a message" };
  const result = runFixture({
    status: 1,
    findings: [FINDING, otherMessage, otherKind, earlier, FINDING],
    baseline: [],
    args: ["--write"],
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.baseline).toBe(
    `${JSON.stringify(
      [
        { count: 1, ...earlier },
        { count: 1, ...otherKind },
        { count: 1, ...otherMessage },
        { count: 2, ...FINDING },
      ],
      null,
      2,
    )}\n`,
  );
});

test("malformed findings fail instead of silently producing an empty baseline", () => {
  const result = runFixture({
    status: 0,
    findings: [{ kind: "syntax-check" }],
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "actionlint output must be an array of findings",
  );
});
