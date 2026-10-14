import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AUTHORIZED_WORKSPACE_OWNER_FILE,
  AUTHORIZED_WORKSPACE_OWNER_MODULE,
  classifyMatterAccessModule,
  evaluateMatterAccessCensus,
} from "./matter-access-census";
import type { MatterAccessFinding } from "./matter-access-census";
import allowlist from "./matter-access-census.allowlist.json";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const ALLOWLIST_PATH =
  "apps/api/src/tests/security/matter-access-census.allowlist.json";

const isProductionSource = (file: string) =>
  !file.endsWith(".test.ts") &&
  !file.includes("/tests/") &&
  !file.includes("/__fixtures__/");

const collectFindings = (): MatterAccessFinding[] => {
  const findings: MatterAccessFinding[] = [];
  for (const file of new Glob("apps/api/src/**/*.ts").scanSync({
    cwd: repoRoot,
  })) {
    if (!isProductionSource(file)) {
      continue;
    }
    const source = readFileSync(path.join(repoRoot, file), "utf-8");
    findings.push(...classifyMatterAccessModule(file, source));
  }
  return findings;
};

// Modules that hand request and MCP code the actor's workspace set. They
// must take it from the owner module; a local query would be a second source.
const WORKSPACE_SET_PRODUCERS = [
  "apps/api/src/lib/auth.ts",
  "apps/api/src/mcp/context.ts",
] as const;

describe("matter access census", () => {
  const findings = collectFindings();

  test("every module that decides matter access outside the row policies is screened or allowlisted", () => {
    expect(evaluateMatterAccessCensus(findings, allowlist)).toEqual({
      violations: [],
      stale: [],
    });
  });

  test("the census reaches the owner module and finds it screened", () => {
    expect(findings).toContainEqual({
      file: AUTHORIZED_WORKSPACE_OWNER_FILE,
      signal: "reads-authorization-view",
      screened: true,
    });
  });

  test("request and MCP workspace sets come from the owner module", () => {
    for (const file of WORKSPACE_SET_PRODUCERS) {
      const source = readFileSync(path.join(repoRoot, file), "utf-8");
      expect(source).toContain(`from "${AUTHORIZED_WORKSPACE_OWNER_MODULE}"`);
      expect(source).toContain("readAuthorizedWorkspaces(tx");
    }
  });

  test("every allowlist entry states a reason", () => {
    for (const reason of Object.values(allowlist)) {
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  test("the allowlist only shrinks from the merge base", () => {
    const base = Bun.spawnSync(["git", "merge-base", "HEAD", "origin/main"], {
      cwd: repoRoot,
    });
    expect(base.exitCode).toBe(0);
    const revision = new TextDecoder().decode(base.stdout).trim();
    const present = Bun.spawnSync(
      ["git", "ls-tree", "--name-only", revision, ALLOWLIST_PATH],
      { cwd: repoRoot },
    );
    expect(present.exitCode).toBe(0);
    // The introducing change establishes the allowlist; later changes may
    // only remove entries.
    if (new TextDecoder().decode(present.stdout).trim() === "") {
      return;
    }
    const prior = Bun.spawnSync(
      ["git", "show", `${revision}:${ALLOWLIST_PATH}`],
      { cwd: repoRoot },
    );
    expect(prior.exitCode).toBe(0);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(prior.stdout));
    expect(typeof parsed === "object" && parsed !== null).toBe(true);
    const existing = new Set(
      typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : [],
    );
    expect(Object.keys(allowlist).filter((key) => !existing.has(key))).toEqual(
      [],
    );
  });
});

describe("matter access census self-test", () => {
  const unscreenedReader = `
    import { inArray } from "drizzle-orm";
    import { rootDb } from "@/api/db/root";
    import { entities } from "@/api/db/schema";
    export const readTitles = async (workspaceIds: string[]) =>
      await rootDb
        .select({ title: entities.name })
        .from(entities)
        .where(inArray(entities.workspaceId, workspaceIds));
  `;

  test("a new owner-connection reader filtered by a workspace set fails the census", () => {
    const findings = classifyMatterAccessModule(
      "apps/api/src/lib/example-reader.ts",
      unscreenedReader,
    );
    expect(findings).toEqual([
      {
        file: "apps/api/src/lib/example-reader.ts",
        signal: "owner-connection-workspace-set",
        screened: false,
      },
    ]);
    expect(evaluateMatterAccessCensus(findings, {}).violations).toEqual([
      "apps/api/src/lib/example-reader.ts::owner-connection-workspace-set",
    ]);
  });

  const classifyReader = (source: string) =>
    classifyMatterAccessModule("apps/api/src/lib/example-reader.ts", source)
      .filter(({ signal }) => signal === "owner-connection-workspace-set")
      .map(({ screened }) => screened);

  test("the reader is screened once its filtered set comes from the owner module", () => {
    const screened = `
      import { inArray } from "drizzle-orm";
      import { rootDb } from "@/api/db/root";
      import { entities } from "@/api/db/schema";
      import { authorizedWorkspaceIds } from "${AUTHORIZED_WORKSPACE_OWNER_MODULE}";
      export const readTitles = async (tx: Tx) => {
        const authorized = await authorizedWorkspaceIds(tx);
        const ids = authorized.value;
        return await rootDb
          .select({ title: entities.name })
          .from(entities)
          .where(inArray(entities.workspaceId, ids));
      };
    `;
    expect(classifyReader(screened)).toEqual([true]);
    expect(
      evaluateMatterAccessCensus(
        classifyMatterAccessModule(
          "apps/api/src/lib/example-reader.ts",
          screened,
        ),
        {},
      ).violations,
    ).toEqual([]);
  });

  test("a module reading the authorization view outside the owner fails, a comment does not", () => {
    const viaSql = classifyMatterAccessModule(
      "apps/api/src/lib/example-view.ts",
      "import { sql } from 'drizzle-orm';\nexport const q = sql`SELECT 1 FROM stella_authorized_workspaces`;",
    );
    expect(viaSql.map((finding) => finding.signal)).toEqual([
      "reads-authorization-view",
    ]);
    expect(viaSql.at(0)?.screened).toBe(false);
    expect(
      classifyMatterAccessModule(
        "apps/api/src/lib/example-comment.ts",
        "// reads stella_authorized_workspaces elsewhere\nexport const rootDbNote = 1;",
      ),
    ).toEqual([]);
  });

  test("a module re-deriving the matter access rule fails the census", () => {
    const findings = classifyMatterAccessModule(
      "apps/api/src/lib/example-rule.ts",
      `
      import { CLIENT_MATTER_ADMIN_ROLES } from "@stll/permissions";
      import { workspaceMembers } from "@/api/db/schema";
      export const reaches = (role: string, memberRow: unknown) =>
        memberRow !== null || CLIENT_MATTER_ADMIN_ROLES.some((r) => r === role);
      export const table = workspaceMembers;
    `,
    );
    expect(findings).toEqual([
      {
        file: "apps/api/src/lib/example-rule.ts",
        signal: "derives-matter-access",
        screened: false,
      },
    ]);
  });

  test("an allowlist entry whose finding is gone is reported as stale", () => {
    expect(
      evaluateMatterAccessCensus([], {
        "apps/api/src/lib/example-reader.ts::owner-connection-workspace-set":
          "reason",
      }).stale,
    ).toEqual([
      "apps/api/src/lib/example-reader.ts::owner-connection-workspace-set",
    ]);
  });
});
