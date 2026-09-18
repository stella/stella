import { describe, expect, test } from "bun:test";

import {
  applyAllowlist,
  checkFile,
  formatProblem,
  type Repo,
} from "./check-instruction-references";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    scripts: { verify: "bash scripts/verify.sh" },
  }),
  "apps/api/package.json": JSON.stringify({
    name: "@stll/api",
    scripts: { "db:migrate": "drizzle-kit migrate" },
  }),
  "apps/api/src/lib/csv.ts":
    "export const escapeCSV = (value: string) => value;",
  "packages/ui/package.json": JSON.stringify({
    name: "@stll/ui",
    exports: { ".": "./src/index.ts" },
  }),
  "packages/ui/src/index.ts": 'export { Button } from "./components/button";',
  "scripts/verify.sh": "#!/usr/bin/env bash\n",
  ".oxlint-plugins/security-guards.ts": "// rules\n",
  "oxlint.config.ts": '{ "security-guards/no-unscoped-user-query": "error" }',
};

const repo: Repo = {
  exists: (repoPath) =>
    Object.keys(FILES).some(
      (file) => file === repoPath || file.startsWith(`${repoPath}/`),
    ),
  read: (repoPath) => FILES[repoPath],
};

const check = (text: string): string[] =>
  checkFile(repo, "FIXTURE.md", text).map(formatProblem);

describe("repository paths", () => {
  test("accepts a path that exists", () => {
    expect(check("Run `bash scripts/verify.sh` before pushing.")).toEqual([]);
  });

  test("reports a path that has moved", () => {
    expect(check("Run `bash scripts/check-all.sh` before pushing.")).toEqual([
      "FIXTURE.md:1: path scripts/check-all.sh (no such file or directory)",
    ]);
  });

  test("ignores a glob", () => {
    expect(check("Covers `apps/*/src/**/*.ts`.")).toEqual([]);
  });
});

describe("bun commands", () => {
  test("accepts a root script", () => {
    expect(check("Run `bun run verify`.")).toEqual([]);
  });

  test("reports a root script that no longer exists", () => {
    expect(check("Run `bun run validate`.")).toEqual([
      "FIXTURE.md:1: command validate (no such script in package.json)",
    ]);
  });

  test("accepts a workspace-filtered script", () => {
    expect(check("Run `bun --filter @stll/api db:migrate`.")).toEqual([]);
  });

  test("reports a workspace-filtered script that no longer exists", () => {
    expect(check("Run `bun --filter @stll/api db:seed`.")).toEqual([
      "FIXTURE.md:1: command db:seed (no such script in apps/api/package.json)",
    ]);
  });
});

describe("module exports", () => {
  test("accepts a named export that the module declares", () => {
    expect(
      check("Use `escapeCSV` from `@/api/lib/csv` for CSV cells."),
    ).toEqual([]);
  });

  test("reports a renamed export", () => {
    expect(
      check("Use `escapeCsvCell` from `@/api/lib/csv` for CSV cells."),
    ).toEqual([
      "FIXTURE.md:1: export escapeCsvCell (apps/api/src/lib/csv.ts exports no escapeCsvCell)",
    ]);
  });

  // Hard-wrapped prose puts the specifier on the following line.
  test("matches the export form across a line break", () => {
    expect(
      check("Use `escapeCSV` from\n`@/api/lib/csv` for CSV cells."),
    ).toEqual([]);
  });

  test("resolves a package through its exports map", () => {
    expect(check("Import `Button` from `@stll/ui`.")).toEqual([]);
  });
});

describe("oxlint rule ids", () => {
  test("accepts a registered rule", () => {
    expect(
      check("Enforced by `security-guards/no-unscoped-user-query`."),
    ).toEqual([]);
  });

  test("reports a rule its plugin no longer registers", () => {
    expect(check("Enforced by `security-guards/no-unscoped-query`.")).toEqual([
      "FIXTURE.md:1: rule security-guards/no-unscoped-query (no such oxlint plugin rule)",
    ]);
  });

  test("ignores a token whose plugin is not a stella plugin module", () => {
    expect(check("Rebase onto `origin/main`.")).toEqual([]);
  });
});

describe("allowlist", () => {
  test("suppresses the problem it names", () => {
    const { problems, staleEntries } = applyAllowlist(
      checkFile(repo, "FIXTURE.md", "See `docs/gone.md`."),
      [
        {
          file: "FIXTURE.md",
          reference: "docs/gone.md",
          reason: "illustrative path",
        },
      ],
    );
    expect(problems).toEqual([]);
    expect(staleEntries).toEqual([]);
  });

  test("fails an entry that suppresses nothing", () => {
    const { staleEntries } = applyAllowlist(
      checkFile(repo, "FIXTURE.md", "See `scripts/verify.sh`."),
      [
        {
          file: "FIXTURE.md",
          reference: "docs/gone.md",
          reason: "illustrative path",
        },
      ],
    );
    expect(staleEntries).toHaveLength(1);
  });
});
