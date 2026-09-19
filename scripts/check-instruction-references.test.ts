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
    "export const escapeCSV = (value: string) => value; export const $value = 1;",
  "apps/api/src/lib/folder/index.ts": "export const nestedValue = 1;",
  "packages/ui/package.json": JSON.stringify({
    name: "@stll/ui",
    exports: {
      ".": { types: "./src/index.ts", import: "./src/index.ts" },
    },
  }),
  "packages/ui/src/index.ts": 'export { Button } from "./components/button";',
  "packages/ui/src/private.ts": "export const privateValue = 1;",
  "packages/transactional/package.json": JSON.stringify({
    name: "@stll/transactional",
    exports: { "./emails/*": "./emails/*.tsx" },
  }),
  "packages/transactional/emails/invite.tsx":
    "export const InviteEmail = () => null;",
  "packages/agent-input/package.json": JSON.stringify({
    name: "@stll/agent-input",
    exports: "./src/index.ts",
  }),
  "packages/agent-input/src/index.ts": "export const normalizeAgentInput = 1;",
  "scripts/verify.sh": "#!/usr/bin/env bash\n",
  ".oxlint-plugins/security-guards.ts": "// rules\n",
  ".oxlint-plugins/no-unscoped-query.ts": "// unrelated plugin\n",
  "oxlint.config.ts":
    '{ "security-guards/no-unscoped-user-query": "error", "note": "security-guards/not-registered" }',
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

  test("resolves a directory specifier to its index module", () => {
    expect(check("Use `nestedValue` from `@/api/lib/folder`.")).toEqual([]);
  });

  test("does not expose a package subpath missing from its exports map", () => {
    expect(check("Import `privateValue` from `@stll/ui/private`.")).toEqual([
      "FIXTURE.md:1: export privateValue (@stll/ui/private does not resolve to a module)",
    ]);
  });

  test("matches declaration names containing a dollar sign", () => {
    expect(check("Use `$value` from `@/api/lib/csv`.")).toEqual([]);
  });

  test("resolves a wildcard package export", () => {
    expect(
      check("Use `InviteEmail` from `@stll/transactional/emails/invite`."),
    ).toEqual([]);
  });

  test("resolves a direct root package export", () => {
    expect(
      check("Use `normalizeAgentInput` from `@stll/agent-input`."),
    ).toEqual([]);
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

  test("does not accept a rule id mentioned only as a value", () => {
    expect(check("Enforced by `security-guards/not-registered`.")).toEqual([
      "FIXTURE.md:1: rule security-guards/not-registered (no such oxlint plugin rule)",
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
