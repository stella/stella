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
    expect(findings).toContainEqual(
      expect.objectContaining({
        file: AUTHORIZED_WORKSPACE_OWNER_FILE,
        signal: "reads-authorization-view",
        screened: true,
      }),
    );
  });

  test("request and MCP workspace sets come from the owner module", () => {
    for (const file of WORKSPACE_SET_PRODUCERS) {
      const source = readFileSync(path.join(repoRoot, file), "utf-8");
      expect(source).toContain(`from "${AUTHORIZED_WORKSPACE_OWNER_MODULE}"`);
      expect(source).toContain("readAuthorizedWorkspaces(tx");
    }
  });

  test("every allowlist entry states a reason", () => {
    for (const { reason, sites } of Object.values(allowlist)) {
      expect(reason.trim().length).toBeGreaterThan(20);
      expect(Object.keys(sites).length).toBeGreaterThan(0);
      for (const count of Object.values(sites)) {
        expect(Number.isInteger(count) && count > 0).toBe(true);
      }
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
    const priorEntries: Record<string, unknown> =
      typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
    expect(
      Object.keys(allowlist).filter((key) => !(key in priorEntries)),
    ).toEqual([]);
    // A pinned site may only fall or disappear; no new symbol may appear.
    const priorSites = (key: string): Record<string, unknown> => {
      const entry = priorEntries[key];
      return typeof entry === "object" &&
        entry !== null &&
        "sites" in entry &&
        typeof entry.sites === "object" &&
        entry.sites !== null
        ? { ...entry.sites }
        : {};
    };
    const grown = Object.entries(allowlist).flatMap(([key, { sites }]) =>
      key in priorEntries
        ? Object.entries(sites).filter(([symbol, count]) => {
            const before = priorSites(key)[symbol];
            return typeof before !== "number" || count > before;
          })
        : [],
    );
    expect(grown).toEqual([]);
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
        sites: { readTitles: 1, "readTitles#rootDb": 1 },
      },
    ]);
    expect(evaluateMatterAccessCensus(findings, {}).violations).toEqual([
      "apps/api/src/lib/example-reader.ts::owner-connection-workspace-set",
    ]);
  });

  test("an exempted module that gains an access site fails the census", () => {
    const findings = classifyMatterAccessModule(
      "apps/api/src/lib/example-reader.ts",
      `${unscreenedReader}
      export const readMore = async (otherIds: string[]) =>
        await rootDb.select().from(entities).where(inArray(entities.workspaceId, otherIds));`,
    );
    expect(
      evaluateMatterAccessCensus(findings, {
        "apps/api/src/lib/example-reader.ts::owner-connection-workspace-set": {
          reason: "One reviewed projection reader.",
          sites: { readTitles: 1, "readTitles#rootDb": 1 },
        },
      }).violations,
    ).toEqual([
      "apps/api/src/lib/example-reader.ts::owner-connection-workspace-set @ readMore#rootDb: 1 sites, allowed 0",
      "apps/api/src/lib/example-reader.ts::owner-connection-workspace-set @ readMore: 1 sites, allowed 0",
    ]);
  });

  test("an owner-connection reader needs an exemption even when its set comes from the owner module", () => {
    const fromOwner = `
      import { inArray } from "drizzle-orm";
      import { rootDb } from "@/api/db/root";
      import { entities } from "@/api/db/schema";
      import { authorizedWorkspaceIds } from "${AUTHORIZED_WORKSPACE_OWNER_MODULE}";
      export const readTitles = async (tx: Tx) => {
        const ids = (await authorizedWorkspaceIds(tx)).value;
        return await rootDb
          .select({ title: entities.name })
          .from(entities)
          .where(inArray(entities.workspaceId, ids));
      };
    `;
    expect(
      classifyMatterAccessModule(
        "apps/api/src/lib/example-reader.ts",
        fromOwner,
      ).map(({ screened }) => screened),
    ).toEqual([false]);
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

  test("a renamed import of the authorization view is still a use of it", () => {
    expect(
      classifyMatterAccessModule(
        "apps/api/src/lib/example-view.ts",
        `import { stellaAuthorizedWorkspaces as allowed } from "@/api/db/schema";
        export const readAllowed = async (tx: Tx) => await tx.select().from(allowed);`,
      ),
    ).toEqual([
      {
        file: "apps/api/src/lib/example-view.ts",
        signal: "reads-authorization-view",
        screened: false,
        sites: { readAllowed: 1 },
      },
    ]);
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
        sites: { table: 1 },
      },
      {
        file: "apps/api/src/lib/example-rule.ts",
        signal: "names-matter-role-rule",
        screened: false,
        sites: { reaches: 1 },
      },
    ]);
  });

  test("a renamed matters table or connection is still a census member", () => {
    const findings = classifyMatterAccessModule(
      "apps/api/src/lib/example-reader.ts",
      `
      import { inArray } from "drizzle-orm";
      import { rootDb as owner } from "@/api/db/root";
      import { workspaces as matters } from "@/api/db/schema";
      const db = owner;
      export const readMatters = async (ids: string[]) =>
        await db.select().from(matters).where(inArray(matters.id, ids));
    `,
    );
    expect(findings.map(({ signal, sites }) => [signal, sites])).toEqual([
      [
        "owner-connection-workspace-set",
        { readMatters: 1, "db#rootDb": 1, "readMatters#rootDb": 1 },
      ],
    ]);
  });

  test("a reviewed module that starts using the owner connection in another symbol needs its entry updated", () => {
    const reader = (connection: string) => `
      import { inArray } from "drizzle-orm";
      import { rootDb } from "@/api/db/root";
      import { entities } from "@/api/db/schema";
      export const readIndex = async (ids: string[]) =>
        await rootDb.select().from(entities).where(inArray(entities.workspaceId, ids));
      export const readScoped = async (tx: Tx, ids: string[]) =>
        await search(ids, ${connection});
    `;
    const file = "apps/api/src/lib/example-reader.ts";
    const allowed = classifyMatterAccessModule(file, reader("tx"));
    const reviewed = {
      [`${file}::owner-connection-workspace-set`]: {
        reason: "One reviewed index reader.",
        sites: allowed[0]?.sites ?? {},
      },
    };
    expect(evaluateMatterAccessCensus(allowed, reviewed).violations).toEqual(
      [],
    );
    expect(
      evaluateMatterAccessCensus(
        classifyMatterAccessModule(file, reader("rootDb")),
        reviewed,
      ).violations,
    ).toEqual([
      `${file}::owner-connection-workspace-set @ readScoped#rootDb: 1 sites, allowed 0`,
    ]);
  });

  test("aliases taken through a namespace, destructuring or a local predicate name stay tracked", () => {
    const file = "apps/api/src/lib/example-reader.ts";
    const reader = (connection: string) => `
      import { inArray } from "drizzle-orm";
      import * as root from "@/api/db/root";
      import { workspaces } from "@/api/db/schema";
      const owner = root.rootDb;
      const { rootDb: unscoped } = root;
      const within = inArray;
      export const readMatters = async (ids: string[]) =>
        await unscoped.select().from(workspaces).where(within(workspaces.id, ids));
      export const readScoped = async (tx: Tx, ids: string[]) =>
        await search(ids, ${connection});
    `;
    const allowed = classifyMatterAccessModule(file, reader("tx"));
    expect(allowed.map(({ signal, sites }) => [signal, sites])).toEqual([
      [
        "owner-connection-workspace-set",
        { readMatters: 1, "owner#rootDb": 1, "readMatters#rootDb": 1 },
      ],
    ]);
    const reviewed = {
      [`${file}::owner-connection-workspace-set`]: {
        reason: "One reviewed reader.",
        sites: allowed[0]?.sites ?? {},
      },
    };
    expect(
      evaluateMatterAccessCensus(
        classifyMatterAccessModule(file, reader("owner")),
        reviewed,
      ).violations,
    ).toEqual([
      `${file}::owner-connection-workspace-set @ readScoped#rootDb: 1 sites, allowed 0`,
    ]);
  });

  test("an extracted matter column and a relative owner-connection import are still found", () => {
    for (const [imports, prelude, column] of [
      [
        `import { rootDb } from "../db/root";`,
        "const matterColumn = entities.workspaceId;",
        "matterColumn",
      ],
      [
        `import { rootDb } from "../db/root.ts";`,
        "const { workspaceId } = entities;",
        "workspaceId",
      ],
      [
        `import * as root from "../db/root"; const rootDb = root.rootDb;`,
        "const { id: matterId } = workspaces;",
        "matterId",
      ],
    ] as const) {
      const findings = classifyMatterAccessModule(
        "apps/api/src/lib/example-reader.ts",
        `import { inArray } from "drizzle-orm";
        ${imports}
        import { entities, workspaces } from "@/api/db/schema";
        ${prelude}
        export const read = async (ids: string[]) =>
          await rootDb.select().from(entities).where(inArray(${column}, ids));`,
      );
      expect(
        findings.map(({ signal, sites }) => [signal, sites["read"]]),
        `${imports} ${prelude}`,
      ).toEqual([["owner-connection-workspace-set", 1]]);
    }
  });

  test("a SQL-wrapped matter column and a local predicate helper are still set filters", () => {
    for (const [prelude, filter] of [
      ["", `inArray(sql\`\${entities.workspaceId}\`, ids)`],
      [
        "const within = (column: AnyColumn, values: string[]) => inArray(column, values);",
        "within(entities.workspaceId, ids)",
      ],
      [
        "function within(column: AnyColumn, values: string[]) { return inArray(column, values); }",
        `within(sql\`\${workspaces.id}\`, ids)`,
      ],
    ] as const) {
      const findings = classifyMatterAccessModule(
        "apps/api/src/lib/example-reader.ts",
        `import { inArray, sql } from "drizzle-orm";
        import { rootDb } from "@/api/db/root";
        import { entities, workspaces } from "@/api/db/schema";
        ${prelude}
        export const read = async (ids: string[]) =>
          await rootDb.select().from(entities).where(${filter});`,
      );
      expect(
        findings.map(({ signal, sites }) => [signal, sites["read"]]),
        filter,
      ).toEqual([["owner-connection-workspace-set", 1]]);
    }
  });

  test("an allowlist entry whose finding is gone is reported as stale", () => {
    expect(
      evaluateMatterAccessCensus([], {
        "apps/api/src/lib/example-reader.ts::owner-connection-workspace-set": {
          reason: "reason",
          sites: { readTitles: 1 },
        },
      }).stale,
    ).toEqual([
      "apps/api/src/lib/example-reader.ts::owner-connection-workspace-set",
    ]);
  });
});
