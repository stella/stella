import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.resolve(
  import.meta.dir,
  "prepare-external-contract-base.sh",
);

test("the external contract CI step prepares its shallow merge base", () => {
  const workflow = readFileSync(
    path.resolve(import.meta.dir, "../.github/workflows/ci.yml"),
    "utf-8",
  );
  expect(workflow).toContain(
    'base="$(bash scripts/prepare-external-contract-base.sh)"',
  );
});

const git = (cwd: string, args: readonly string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};

test("a shallow checkout fetches only the ancestry needed to resolve its event base", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "external-contract-base-"));
  try {
    const source = path.join(fixture, "source");
    const checkout = path.join(fixture, "checkout");
    git(fixture, ["init", "-b", "main", source]);
    git(source, ["config", "user.name", "Contract Test"]);
    git(source, ["config", "user.email", "contract@example.invalid"]);
    writeFileSync(path.join(source, "state"), "base\n");
    git(source, ["add", "state"]);
    git(source, ["commit", "-m", "base"]);
    const base = git(source, ["rev-parse", "HEAD"]);
    git(source, ["checkout", "-b", "feature"]);
    for (const value of ["one", "two"]) {
      writeFileSync(path.join(source, "state"), `${value}\n`);
      git(source, ["commit", "-am", value]);
    }
    git(fixture, [
      "clone",
      "--depth=1",
      "--branch=feature",
      `file://${source}`,
      checkout,
    ]);
    expect(git(checkout, ["rev-parse", "--is-shallow-repository"])).toBe(
      "true",
    );
    const before = Bun.spawnSync(["git", "merge-base", "HEAD", base], {
      cwd: checkout,
    });
    expect(before.exitCode).not.toBe(0);

    const prepared = Bun.spawnSync(["bash", script], {
      cwd: checkout,
      env: { ...process.env, CHECK_BASE_REF: base },
    });
    expect(prepared.exitCode, prepared.stderr.toString()).toBe(0);
    expect(prepared.stdout.toString().trim()).toBe(base);
    expect(git(checkout, ["merge-base", "HEAD", base])).toBe(base);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a shallow checkout deepens both sides of a diverged history", () => {
  const fixture = mkdtempSync(
    path.join(tmpdir(), "external-contract-diverged-"),
  );
  try {
    const source = path.join(fixture, "source");
    const checkout = path.join(fixture, "checkout");
    git(fixture, ["init", "-b", "main", source]);
    git(source, ["config", "user.name", "Contract Test"]);
    git(source, ["config", "user.email", "contract@example.invalid"]);
    writeFileSync(path.join(source, "common"), "common\n");
    git(source, ["add", "common"]);
    git(source, ["commit", "-m", "common"]);
    const common = git(source, ["rev-parse", "HEAD"]);
    git(source, ["checkout", "-b", "feature"]);
    writeFileSync(path.join(source, "feature"), "one\n");
    git(source, ["add", "feature"]);
    git(source, ["commit", "-m", "feature one"]);
    writeFileSync(path.join(source, "feature"), "two\n");
    git(source, ["commit", "-am", "feature two"]);
    git(source, ["checkout", "main"]);
    for (let index = 1; index <= 40; index += 1) {
      writeFileSync(path.join(source, "main"), `${index}\n`);
      git(source, ["add", "main"]);
      git(source, ["commit", "-m", `main ${index}`]);
    }
    const base = git(source, ["rev-parse", "HEAD"]);
    git(fixture, [
      "clone",
      "--depth=1",
      "--branch=feature",
      `file://${source}`,
      checkout,
    ]);
    const head = git(checkout, ["rev-parse", "HEAD"]);
    const bin = path.join(fixture, "bin");
    const fetchLog = path.join(fixture, "fetch.log");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "git"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FETCH_LOG"\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(path.join(bin, "git"), 0o755);

    const prepared = Bun.spawnSync(["bash", script], {
      cwd: checkout,
      env: {
        ...process.env,
        CHECK_BASE_REF: base,
        FETCH_LOG: fetchLog,
        PATH: `${bin}:${process.env.PATH}`,
        REAL_GIT: Bun.which("git") ?? "git",
      },
    });
    expect(prepared.exitCode, prepared.stderr.toString()).toBe(0);
    expect(prepared.stdout.toString().trim()).toBe(common);
    expect(readFileSync(fetchLog, "utf-8")).toContain(
      `fetch --no-tags --deepen=32 origin ${head} ${base}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("an unavailable base still fails closed", () => {
  const result = Bun.spawnSync(["bash", script], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, CHECK_BASE_REF: "missing-contract-base" },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "ExternalContractBaselineUnavailable: cannot resolve merge-base",
  );
});
