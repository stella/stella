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
const step =
  workflow.jobs["release-typecheck"].steps.find(
    ({ name }) => name === "Full release typecheck",
  ) ?? panic("Missing full release typecheck");
const command = step.run ?? panic("Missing release typecheck command");
const scripts = v.parse(
  v.object({
    scripts: v.object({ typecheck: v.string(), "typecheck:repo": v.string() }),
  }),
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  ),
).scripts;

const assertBounded = (candidate = command) => {
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
        ...step.env,
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(
      readFileSync(calls, "utf-8"),
      "release compiler tasks must run serially before the repository check",
    ).toBe("run typecheck --concurrency=1\nrepo\n");
    expect(scripts["typecheck:repo"]).not.toContain("turbo");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("the release job forwards a serial task limit to Turbo and retains the subsequent repository checks", () =>
  assertBounded());
test("removing or increasing release concurrency, bypassing it with parallel, or dropping repository checks violates the contract", () => {
  for (const mutant of [
    command.replace(" --concurrency=1", ""),
    command.replace("--concurrency=1", "--concurrency=2"),
    command.replace("--concurrency=1", "--concurrency=10"),
    command.replace("--concurrency=1", "--concurrency=1 --parallel"),
    command.replace(" && bun run typecheck:repo", ""),
  ]) {
    expect(mutant).not.toBe(command);
    expect(() => assertBounded(mutant)).toThrow(
      "release compiler tasks must run serially",
    );
  }
});
