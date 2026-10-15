import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const workflow = v.parse(
  v.looseObject({
    jobs: v.looseObject({
      "release-typecheck": v.looseObject({
        "timeout-minutes": v.number(),
        steps: v.array(
          v.looseObject({
            name: v.optional(v.string()),
            run: v.optional(v.string()),
            env: v.optional(v.record(v.string(), v.string())),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const nightlyWorkflow = v.parse(
  v.looseObject({
    jobs: v.looseObject({
      "full-typecheck": v.looseObject({
        "timeout-minutes": v.number(),
        steps: v.array(
          v.looseObject({
            name: v.optional(v.string()),
            run: v.optional(v.string()),
            env: v.optional(v.record(v.string(), v.string())),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/nightly-typecheck.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const step =
  workflow.jobs["release-typecheck"].steps.find(
    ({ name }) => name === "Full release typecheck",
  ) ?? panic("Missing full release typecheck");
const command = step.run ?? panic("Missing release typecheck command");
const nightlyStep =
  nightlyWorkflow.jobs["full-typecheck"].steps.find(
    ({ name }) => name === "Full typecheck (no --affected, no turbo cache)",
  ) ?? panic("Missing nightly full typecheck");
const nightlyCommand =
  nightlyStep.run ?? panic("Missing nightly typecheck command");
const scripts = v.parse(
  v.object({
    scripts: v.object({ typecheck: v.string(), "typecheck:repo": v.string() }),
  }),
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  ),
).scripts;

type AssertBoundedOptions = {
  candidate: string;
  env: Record<string, string> | undefined;
  failureMessage: string;
};

const assertBounded = ({
  candidate,
  env,
  failureMessage,
}: AssertBoundedOptions) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "release-typecheck-contract-"),
  );
  try {
    mkdirSync(path.join(directory, "node_modules/.bin"), { recursive: true });
    // Exercise Bun's argument forwarding and the real root script with a fake
    // Turbo; this test never invokes a compiler.
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: scripts.typecheck,
          "typecheck:repo": "printf 'repo\\n' >> \"$CALLS\"",
        },
      }),
    );
    writeFileSync(
      path.join(directory, "node_modules/.bin/turbo"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CALLS"\n',
      { mode: 0o755 },
    );
    const calls = path.join(directory, "calls");
    const result = Bun.spawnSync(["bash", "-ec", candidate], {
      cwd: directory,
      env: {
        PATH: `${path.dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
        CALLS: calls,
        ...env,
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(calls, "utf-8"), failureMessage).toBe(
      "run typecheck --concurrency=1\nrepo\n",
    );
    expect(scripts["typecheck:repo"]).not.toContain("turbo");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("the release job forwards a serial task limit to Turbo and retains the subsequent repository checks", () => {
  expect(
    workflow.jobs["release-typecheck"]["timeout-minutes"],
    "serial release typechecks retain their time budget",
  ).toBeGreaterThanOrEqual(40);
  assertBounded({
    candidate: command,
    env: step.env,
    failureMessage:
      "release compiler tasks must run serially before the repository check",
  });
});
test("removing or increasing release concurrency, bypassing it with parallel, or dropping repository checks violates the contract", () => {
  for (const mutant of [
    command.replace(" --concurrency=1", ""),
    command.replace("--concurrency=1", "--concurrency=2"),
    command.replace("--concurrency=1", "--concurrency=10"),
    command.replace("--concurrency=1", "--concurrency=1 --parallel"),
    command.replace(" && bun run typecheck:repo", ""),
  ]) {
    expect(mutant).not.toBe(command);
    expect(() =>
      assertBounded({
        candidate: mutant,
        env: step.env,
        failureMessage:
          "release compiler tasks must run serially before the repository check",
      }),
    ).toThrow("release compiler tasks must run serially");
  }
});

test("the nightly job serializes Turbo before repository checks", () => {
  expect(
    nightlyWorkflow.jobs["full-typecheck"]["timeout-minutes"],
    "serial nightly typechecks retain their time budget",
  ).toBeGreaterThanOrEqual(40);
  assertBounded({
    candidate: nightlyCommand,
    env: nightlyStep.env,
    failureMessage:
      "nightly compiler tasks must run serially before the repository check",
  });
});

test("nightly typecheck concurrency and repository checks stay enforced", () => {
  for (const mutant of [
    nightlyCommand.replace(" --concurrency=1", ""),
    nightlyCommand.replace("--concurrency=1", "--concurrency=2"),
    nightlyCommand.replace("--concurrency=1", "--concurrency=10"),
    nightlyCommand.replace("--concurrency=1", "--concurrency=1 --parallel"),
    nightlyCommand.replace(" && bun run typecheck:repo", ""),
  ]) {
    expect(mutant).not.toBe(nightlyCommand);
    expect(() =>
      assertBounded({
        candidate: mutant,
        env: nightlyStep.env,
        failureMessage:
          "nightly compiler tasks must run serially before the repository check",
      }),
    ).toThrow("nightly compiler tasks must run serially");
  }
});
