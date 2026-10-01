import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const script = path.join(
  import.meta.dirname,
  "detect-security-workflow-changes.sh",
);
const workflowSchema = v.looseObject({
  on: v.looseObject({
    pull_request: v.looseObject({ paths: v.optional(v.array(v.string())) }),
  }),
  jobs: v.record(v.string(), v.unknown()),
});
const readWorkflow = (name: string) =>
  v.parse(
    workflowSchema,
    Bun.YAML.parse(
      readFileSync(
        path.join(import.meta.dirname, `../.github/workflows/${name}.yml`),
        "utf-8",
      ),
    ),
  );
const codeql = readWorkflow("codeql");
const migrations = readWorkflow("db-migrations");
const analyze = v.parse(
  v.looseObject({
    strategy: v.looseObject({
      matrix: v.object({ language: v.array(v.string()) }),
    }),
  }),
  codeql.jobs["analyze"],
);
const javascript = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
const languageExtensions = new Map([
  ["javascript", javascript],
  ["typescript", javascript],
  ["javascript-typescript", javascript],
  ["python", ["py", "pyi"]],
  ["rust", ["rs"]],
  ["actions", [".github/workflows/check.yml", ".github/workflows/check.yaml"]],
]);
const detect = (scope: string, files: string[], detector = script) => {
  const result = Bun.spawnSync(["bash", detector, scope, "--files", ...files]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
};
const expectLanguageCoverage = (language: string, detector = script) => {
  const extensions = languageExtensions.get(language);
  if (!extensions) {
    panic(`Unmapped CodeQL language: ${language}`);
  }
  for (const extension of extensions) {
    const file =
      language === "actions" ? extension : `nested/source.${extension}`;
    expect(detect("codeql", [file], detector), `${language}: ${file}`).toBe(
      "true",
    );
  }
};

test("every language in the actual CodeQL matrix has complete detector coverage", () => {
  expect(analyze.strategy.matrix.language.length).toBeGreaterThan(0);
  for (const language of analyze.strategy.matrix.language) {
    expectLanguageCoverage(language);
  }
});

test("adding an unmapped CodeQL language or dropping an extension fails coverage", () => {
  expect(() => expectLanguageCoverage("unmapped-language")).toThrow(
    "Unmapped CodeQL language",
  );
  const directory = mkdtempSync(
    path.join(tmpdir(), "security-filter-mutation-"),
  );
  try {
    const source = readFileSync(script, "utf-8");
    expect(source).toContain("|*.mts|");
    const mutated = source.replace("|*.mts|", "|");
    expect(mutated).not.toBe(source);
    const detector = path.join(directory, "detector.sh");
    writeFileSync(detector, mutated);
    expect(detect("codeql", ["source.mts"])).toBe("true");
    expect(detect("codeql", ["source.mts"], detector)).toBe("false");
    expect(() => expectLanguageCoverage("javascript", detector)).toThrow(
      "nested/source.mts",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodeQL selects code, workflow configuration and dependency inputs", () => {
  for (const file of [
    "apps/web/src/view.tsx",
    "source.ts",
    "worker.py",
    "src/main.rs",
    "package.json",
    "packages/example/package.json",
    "bun.lock",
    "nested/bun.lockb",
    "Cargo.toml",
    "nested/Cargo.lock",
    "pyproject.toml",
    "uv.lock",
    "nested/requirements-dev.txt",
    "nested/package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    ".github/workflows/example.yml",
    ".github/codeql/config.yml",
    "scripts/detect-security-workflow-changes.sh",
  ]) {
    expect(detect("codeql", [file]), file).toBe("true");
  }
  for (const files of [
    [],
    ["README.md"],
    ["docs/readme.md", "tsconfig.json", ".editorconfig"],
  ]) {
    expect(detect("codeql", files)).toBe("false");
  }
  expect(detect("codeql", ["README.md", "source.ts"])).toBe("true");
});

test("migration coverage preserves every prior dependency and excludes unrelated code", () => {
  for (const file of [
    "apps/api/drizzle/20261001/migration.sql",
    "apps/api/src/db/schema/tables.ts",
    "apps/api/src/lib/db/client.ts",
    "apps/api/src/server.ts",
    "apps/api/drizzle.config.ts",
    "scripts/check-migration-safety.ts",
    "scripts/check-migration-index-builds.test.ts",
    "scripts/migration-index-findings.json",
    "scripts/fixtures/migration-index-builds/create-index/good.sql",
    "scripts/check-migrations.sh",
    "scripts/rehearse-better-auth-constraint-retry.sh",
    ".squawk.toml",
    ".github/workflows/db-migrations.yml",
    ".github/workflows/release.yml",
    "scripts/detect-security-workflow-changes.sh",
  ]) {
    expect(detect("migrations", [file]), file).toBe("true");
  }
  expect(detect("migrations", ["apps/web/src/view.ts", "README.md"])).toBe(
    "false",
  );
});

test("unknown PR bases, diff failures and non-PR events run the checks", () => {
  for (const scope of ["codeql", "migrations"]) {
    for (const env of [
      { EVENT_NAME: "pull_request", BASE_SHA: "", HEAD_SHA: "" },
      {
        EVENT_NAME: "pull_request",
        BASE_SHA: "1".repeat(40),
        HEAD_SHA: "2".repeat(40),
      },
      { EVENT_NAME: "schedule", BASE_SHA: "", HEAD_SHA: "" },
      { EVENT_NAME: "push", BASE_SHA: "", HEAD_SHA: "" },
      { EVENT_NAME: "workflow_dispatch", BASE_SHA: "", HEAD_SHA: "" },
    ]) {
      const result = Bun.spawnSync(["bash", script, scope], {
        cwd: import.meta.dirname,
        env: { ...process.env, ...env },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe("true");
    }
  }
});

test("a complete Git diff selects changed code and deletion paths, including renames", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "security-filter-git-"));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  const selected = (base: string) => {
    const result = Bun.spawnSync(["bash", script, "codeql"], {
      cwd,
      env: {
        ...process.env,
        EVENT_NAME: "pull_request",
        BASE_SHA: base,
        HEAD_SHA: git(["rev-parse", "HEAD"]),
      },
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git(["init", "-q"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    const base = git(["rev-parse", "HEAD"]);
    writeFileSync(path.join(cwd, "README.md"), "docs\n");
    git(["add", "."]);
    git(["commit", "-qm", "docs"]);
    expect(selected(base)).toBe("false");
    git(["mv", "source.ts", "source.md"]);
    git(["commit", "-qm", "rename"]);
    expect(selected(base)).toBe("true");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("both workflows gate every expensive job and run on detector failure", () => {
  for (const workflow of [codeql, migrations]) {
    expect(workflow.on.pull_request.paths).toBeUndefined();
    const scope = v.parse(
      v.looseObject({
        outputs: v.object({ required: v.string() }),
        steps: v.array(v.looseObject({ run: v.optional(v.string()) })),
      }),
      workflow.jobs["scope"],
    );
    expect(scope.outputs.required).toContain("steps.changes.outputs.required");
    const detector = scope.steps.find(({ run }) =>
      run?.includes("detect-security-workflow-changes.sh"),
    );
    expect(detector?.run).toContain("required=true");
    expect(detector?.run).toContain("skipped: no");
    for (const [id, value] of Object.entries(workflow.jobs)) {
      if (id === "scope") {
        continue;
      }
      const job = v.parse(
        v.looseObject({ needs: v.literal("scope"), if: v.string() }),
        value,
      );
      expect(job.if).toContain("always()");
      expect(job.if).toContain("needs.scope.result != 'success'");
      expect(job.if).toContain("needs.scope.outputs.required != 'false'");
    }
  }
  const triggers = v.parse(
    v.looseObject({
      push: v.object({ branches: v.array(v.string()) }),
      schedule: v.array(v.object({ cron: v.string() })),
    }),
    codeql.on,
  );
  expect(triggers.push.branches).toContain("main");
  expect(triggers.schedule).toHaveLength(1);
  expect(triggers.schedule.at(0)?.cron.split(" ").slice(2)).toEqual([
    "*",
    "*",
    "*",
  ]);
});
