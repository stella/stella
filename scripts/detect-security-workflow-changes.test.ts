import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { createSha256 } from "@stll/sha256/node";

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
// Byte-identical upstream supported-language table, kept offline for CI.
// https://github.com/github/codeql/blob/47cc7d8176fc7370c99a3f897035bec0bb924efc/docs/codeql/reusables/supported-versions-compilers.rst
const documentation = readFileSync(
  path.join(
    import.meta.dirname,
    "fixtures/codeql-supported-versions-compilers.rst",
  ),
  "utf-8",
);
const documentedExtensions = (language: string) => {
  const row = documentation.split("\n").find((line) => {
    const trimmed = line.trimStart();
    return (
      trimmed.startsWith(`${language},`) || trimmed.startsWith(`${language} [`)
    );
  });
  if (!row) {
    panic(`Missing CodeQL documentation row: ${language}`);
  }
  const extensions = Array.from(
    row.matchAll(/``([^`]+)``/gu),
    (match) => match[1],
  );
  expect(extensions.length, language).toBeGreaterThan(0);
  return extensions.map((extension) => {
    if (!extension) {
      panic(`Missing CodeQL extension: ${language}`);
    }
    if (extension.startsWith(".") && !extension.startsWith(".github/")) {
      return `nested/source${extension}`;
    }
    return extension.includes("/")
      ? extension.replaceAll("*", "sample")
      : `nested/${extension}`;
  });
};
// CodeQL's JavaScript extractor enables TypeScript by default.
const javascript = documentedExtensions("JavaScript").concat(
  documentedExtensions("TypeScript"),
);
const languageExtensions = new Map([
  ["javascript", javascript],
  ["typescript", javascript],
  ["javascript-typescript", javascript],
  ["python", documentedExtensions("Python")],
  ["rust", documentedExtensions("Rust")],
  ["actions", documentedExtensions("GitHub Actions")],
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
  for (const file of extensions) {
    expect(detect("codeql", [file], detector), `${language}: ${file}`).toBe(
      "true",
    );
  }
};

test("the documented extension baseline is the unchanged pinned upstream table", () => {
  expect(createSha256().update(documentation).digest("hex")).toBe(
    "6d76b52b5f1f1f571ec586326299d606f75a4b42cdc5a9d6ff1edca17e017fdc",
  );
});

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
    const missingHtml = source.replace("*.html|", "");
    expect(missingHtml).not.toBe(source);
    writeFileSync(detector, missingHtml);
    expect(() => expectLanguageCoverage("javascript", detector)).toThrow(
      "nested/source.html",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an HTML-only PR runs CodeQL for embedded JavaScript", () => {
  for (const file of [
    "apps/desktop/src/mainview/takeover-dialog.html",
    "apps/web/index.html",
    "nested/page.htm",
    "nested/PAGE.HTML",
    "nested/page.vue",
    "nested/page.ejs",
    "nested/page.hbs",
    "nested/page.html.erb",
    "nested/page.jsp",
    "nested/page.html.dot",
    "nested/source.xsjs",
    "nested/source.xsjslib",
  ]) {
    expect(detect("codeql", [file]), file).toBe("true");
  }
});

test("CodeQL selects code, workflow configuration and dependency inputs", () => {
  for (const file of [
    "apps/web/src/view.tsx",
    "source.ts",
    "tsconfig.json",
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
    ["docs/readme.md", ".editorconfig"],
  ]) {
    expect(detect("codeql", files)).toBe("false");
  }
  expect(detect("codeql", ["README.md", "source.ts"])).toBe("true");
});

test("migration coverage includes schema, runtime and check inputs and excludes unrelated code", () => {
  const config = readFileSync(
    new URL("../apps/api/drizzle.config.ts", import.meta.url),
    "utf-8",
  );
  const schemaSources = [...config.matchAll(/"(\.\/src\/db\/[^"\n]+)"/gu)].map(
    (match) => match[1],
  );
  expect(schemaSources.length).toBeGreaterThan(0);
  for (const source of schemaSources) {
    if (source === undefined) {
      panic("Schema source did not match");
    }
    expect(detect("migrations", [`apps/api/${source.slice(2)}`]), source).toBe(
      "true",
    );
  }
  for (const file of [
    "apps/api/drizzle/20261001/migration.sql",
    "apps/api/src/db/schema/tables.ts",
    "apps/api/drizzle.config.ts",
    "apps/api/src/db/migrate.ts",
    "apps/api/src/db/shared-pool-timeouts.ts",
    "apps/api/src/db/adaptive-backfill.test.ts",
    "apps/api/src/lib/db/client.ts",
    ".github/workflows/db-migrations.yml",
    "scripts/detect-security-workflow-changes.sh",
    "scripts/detect-security-workflow-changes.test.ts",
    "scripts/rehearse-better-auth-constraint-retry.sh",
    "scripts/fixtures/migration-example/input.sql",
    ...readdirSync(import.meta.dirname)
      .filter((entry) => entry.includes("migrat"))
      .map((entry) => `scripts/${entry}`),
  ]) {
    expect(detect("migrations", [file]), file).toBe("true");
  }
  expect(
    detect("migrations", [
      "apps/web/src/view.ts",
      "README.md",
      "apps/api/src/server.ts",
    ]),
  ).toBe("false");
});

test("unknown PR bases, diff failures and non-PR events run the checks", () => {
  // Unknown objects in the CI partial clone can trigger remote lazy fetches.
  // One repository without a remote exercises diff failure without network I/O.
  const cwd = mkdtempSync(path.join(tmpdir(), "security-filter-invalid-base-"));
  try {
    const initialized = Bun.spawnSync(["git", "init", "-q"], { cwd });
    expect(initialized.exitCode).toBe(0);
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
          cwd,
          env: { ...process.env, ...env },
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString().trim()).toBe("true");
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
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
    const docsHead = git(["rev-parse", "HEAD"]);
    writeFileSync(path.join(cwd, "page.html"), "<script>alert(1)</script>\n");
    git(["add", "."]);
    git(["commit", "-qm", "html"]);
    expect(selected(docsHead)).toBe("true");
    const htmlHead = git(["rev-parse", "HEAD"]);
    git(["mv", "source.ts", "source.md"]);
    git(["commit", "-qm", "rename"]);
    expect(selected(htmlHead)).toBe("true");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("both workflows gate every expensive job and run on detector failure", () => {
  for (const workflow of [codeql, migrations]) {
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
  expect(migrations.on.pull_request.paths).toBeUndefined();
  const triggers = v.parse(
    v.looseObject({
      schedule: v.array(v.object({ cron: v.string() })),
    }),
    codeql.on,
  );
  expect(triggers.schedule).toHaveLength(1);
  expect(triggers.schedule.at(0)?.cron.split(" ").slice(2)).toEqual([
    "*",
    "*",
    "*",
  ]);
});

// The PR trigger selects source changes; supplemental data remains covered by
// full scans on main and the nightly schedule.
const supplementalData = new Set(["json", "yaml", "yml", "raml", "xml"]);
const sourceFiles = (language: string) => {
  const files = languageExtensions.get(language);
  if (!files) {
    panic(`Unmapped CodeQL language: ${language}`);
  }
  if (
    !["javascript", "typescript", "javascript-typescript"].includes(language)
  ) {
    return files;
  }
  return files.filter(
    (file) => !supplementalData.has(file.split(".").at(-1) ?? ""),
  );
};
const triggerMatches = (file: string, paths: string[]) =>
  paths.some((glob) => new Bun.Glob(glob).match(file));
const expectTriggerCoverage = (language: string, paths: string[]) => {
  const files = sourceFiles(language);
  expect(files.length, language).toBeGreaterThan(0);
  for (const file of files) {
    expect(triggerMatches(file, paths), `${language}: ${file}`).toBe(true);
  }
};

test("CodeQL PR triggers cover every analyzed language source extension", () => {
  const paths = v.parse(v.array(v.string()), codeql.on.pull_request.paths);
  expect(analyze.strategy.matrix.language.length).toBeGreaterThan(0);
  for (const language of analyze.strategy.matrix.language) {
    expectTriggerCoverage(language, paths);
  }
  for (const file of [
    "source.cjs",
    "source.xsjs",
    "source.xsjslib",
    "page.html.erb",
    "page.jsp",
    "page.html.dot",
    "nested/PAGE.HTML",
    "nested/SOURCE.TS",
    ".github/codeql/config.yml",
    ".github/workflows/codeql.yml",
    "scripts/detect-security-workflow-changes.sh",
  ]) {
    expect(triggerMatches(file, paths), file).toBe(true);
  }
  for (const file of [
    "README.md",
    "docs/guide.md",
    "scripts/fixtures/codeql-supported-versions-compilers.rst",
    "snapshots/result.json",
    "bun.lock",
    "nested/package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "uv.lock",
    "Cargo.lock",
  ]) {
    expect(triggerMatches(file, paths), file).toBe(false);
  }
});

test("CodeQL trigger coverage rejects missing extensions and unknown languages", () => {
  const paths = v.parse(v.array(v.string()), codeql.on.pull_request.paths);
  const missingMts = paths.filter(
    (glob) => !triggerMatches("source.mts", [glob]),
  );
  expect(missingMts).not.toEqual(paths);
  expect(() => expectTriggerCoverage("javascript", missingMts)).toThrow(
    "nested/source.mts",
  );
  expect(() => expectTriggerCoverage("unmapped-language", paths)).toThrow(
    "Unmapped CodeQL language",
  );
});

test("CodeQL scans nightly, manually and on release pull requests only", () => {
  expect(Object.keys(codeql.on)).not.toContain("push");
  const triggers = v.parse(
    v.looseObject({
      pull_request: v.looseObject({
        branches: v.array(v.string()),
        types: v.array(v.string()),
        paths: v.array(v.string()),
      }),
      schedule: v.array(v.object({ cron: v.string() })),
      workflow_dispatch: v.null_(),
    }),
    codeql.on,
  );
  const scope = v.parse(
    v.looseObject({ if: v.string() }),
    codeql.jobs["scope"],
  );
  expect(scope.if).toContain(
    "startsWith(github.event.pull_request.head.ref, 'chore/release-')",
  );
  expect(scope.if).toContain(
    "startsWith(github.event.pull_request.head.ref, 'changeset-release/')",
  );
  expect(triggers.pull_request.branches).toEqual(["main"]);
  expect(triggers.pull_request.types).toEqual([
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
  ]);
  expect(triggers.schedule).toHaveLength(1);
  const cron = triggers.schedule.at(0)?.cron.split(" ");
  expect(cron?.slice(2)).toEqual(["*", "*", "*"]);
  expect(Number(cron?.at(0))).toBeGreaterThan(0);
  expect(Number(cron?.at(0))).toBeLessThan(60);
});
