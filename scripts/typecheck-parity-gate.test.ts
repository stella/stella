import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const gate = workflow
  .split("      - name: Select typecheck parity coverage\n")[1]
  ?.split("\n      - name:")[0];
const source = gate?.split("bun --eval '\n")[1]?.split("\n          ' >>")[0];
if (!source) {
  throw new Error("Missing inline parity gate");
}

const snapshot = (
  bun = "1.4.3",
  typescript = "6.0.3",
  native = "7.0.2",
  other = "1.0.0",
) => ({
  manifest: { packageManager: `bun@${bun}` },
  lock: {
    packages: {
      typescript: [`typescript@${typescript}`],
      "@typescript/native": [`typescript@${native}`],
      unrelated: [`unrelated@${other}`],
    },
  },
});
type Snapshot = ReturnType<typeof snapshot>;
const evaluate = (
  base: Snapshot | undefined,
  head: Snapshot | undefined,
  event = "pull_request",
  baseSha = "base",
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "parity-gate-"));
  try {
    for (const [ref, value] of [
      ["base", base],
      ["HEAD", head],
    ] as const) {
      if (!value) {
        continue;
      }
      writeFileSync(
        path.join(directory, `${ref}-package.json`),
        JSON.stringify(value.manifest),
      );
      // Bun's lockfile permits trailing commas; exercise the actual JSONC parser.
      writeFileSync(
        path.join(directory, `${ref}-bun.lock`),
        JSON.stringify(value.lock).replace(/\}\}$/u, "},}"),
      );
    }
    const git = path.join(directory, "git");
    writeFileSync(
      git,
      `#!${process.execPath}\nimport { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "rev-parse") { console.log("base"); }
else { try { console.log(readFileSync(process.env.FIXTURE + "/" + args[1].replace(":", "-"), "utf8")); }
catch { process.stderr.write("Missing comparison tree"); process.exit(1); } }\n`,
    );
    chmodSync(git, 0o755);
    return Bun.spawnSync([process.execPath, "--eval", source], {
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        FIXTURE: directory,
        EVENT_NAME: event,
        BASE_SHA: baseSha,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("parity compares resolved compilers while ignoring unrelated lockfile edits", () => {
  const baseline = snapshot();
  for (const [changed, required] of [
    [snapshot(), false],
    [snapshot("1.4.3", "6.0.3", "7.0.2", "2.0.0"), false],
    [snapshot("1.4.4"), true],
    [snapshot("1.4.3", "6.0.4"), true],
    [snapshot("1.4.3", "6.0.3", "7.0.3"), true],
  ] as const) {
    const result = evaluate(baseline, changed);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe(`required=${required}`);
  }
});

test("scheduled and manual proofs run without a comparison tree", () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const result = evaluate(undefined, undefined, event, "");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("required=true");
  }
});

test("missing versions or comparison trees fail instead of silently skipping parity", () => {
  const missingCompiler = snapshot();
  delete (
    missingCompiler.lock.packages as Partial<Snapshot["lock"]["packages"]>
  ).typescript;
  delete (
    missingCompiler.lock.packages as Partial<Snapshot["lock"]["packages"]>
  )["@typescript/native"];
  for (const base of [undefined, missingCompiler]) {
    const result = evaluate(base, snapshot());
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).not.toContain("required=false");
  }
});

test("merge groups compare their base and base-less calls compare the parent", () => {
  for (const [event, baseSha] of [
    ["merge_group", "base"],
    ["push", ""],
  ]) {
    const result = evaluate(snapshot("1.4.2"), snapshot(), event, baseSha);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("required=true");
  }
});

test("only full parity and its report use the version gate; every PR keeps the error probe", () => {
  const gated = [
    "Typecheck parity (all checked projects)",
    "Record typecheck parity report",
    "Upload typecheck parity report",
  ];
  for (const name of [...gated, "Typecheck command rejects errors"]) {
    const block = workflow
      .split(`      - name: ${name}\n`)[1]
      ?.split("\n      - name:")[0];
    expect(block).toBeDefined();
    expect(
      block?.includes("steps.typecheck_parity_gate.outputs.required == 'true'"),
    ).toBe(gated.includes(name));
  }
  const nightly = readFileSync(
    new URL("../.github/workflows/nightly-typecheck.yml", import.meta.url),
    "utf-8",
  );
  expect(nightly).toContain("schedule:");
  expect(nightly).toContain("workflow_dispatch:");
  expect(nightly).toContain("run: bun run check:typecheck-parity");
});
