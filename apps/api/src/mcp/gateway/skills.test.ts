import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// skills.ts routes its only failure path (a Result.err from safeDb) through
// captureError; mock it so the failure test stays hermetic and can assert the
// error is captured (not silently swallowed) rather than depending on PostHog.
const captureErrorMock = mock();
void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: mock(),
}));

const { loadVisibleSkillTools, resolveSkillTool } =
  await import("@/api/mcp/gateway/skills");

type SkillRow = {
  id: ReturnType<typeof toSafeId<"agentSkill">>;
  scope: "team" | "private";
  userId: string;
  slug: string;
  name: string;
  description: string;
  version: string | null;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  body: string;
  origin: "authored" | "bundled" | "upload" | "url";
};

const OWNER = "user_owner";

const skillRow = (
  overrides: Partial<SkillRow> & { slug: string },
): SkillRow => ({
  id: toSafeId<"agentSkill">(`skill_${overrides.slug}`),
  scope: "private",
  userId: OWNER,
  name: overrides.slug,
  description: `desc ${overrides.slug}`,
  version: "1.0.0",
  license: null,
  compatibility: null,
  metadata: {},
  body: `body ${overrides.slug}`,
  origin: "authored",
  ...overrides,
});

// The fake tx mirrors the real query chain
// (`select().from().where().orderBy().limit()`); only the terminal `.limit()`
// resolves, to the canned rows. The WHERE clause (org/user/enabled scoping) is
// enforced by Postgres, so a mocked builder cannot exercise it — see the note
// at the bottom of this file.
const createSelectBuilder = (rows: readonly SkillRow[]) => {
  const builder = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: async () => rows,
  };
  return builder;
};

const createContext = ({
  dbError,
  rows = [],
}: {
  dbError?: Error;
  rows?: readonly SkillRow[];
} = {}): McpRequestContext => {
  const tx = { select: () => createSelectBuilder(rows) };
  const safeDb: McpRequestContext["safeDb"] = async (callback) => {
    if (dbError) {
      return Result.err(dbError);
    }
    // oxlint-disable-next-line node/callback-return -- result must be wrapped in Result.ok, not returned raw
    return Result.ok(await callback(asTestRaw<Transaction>(tx)));
  };

  return asTestRaw<McpRequestContext>({
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw<AuditRecorder>(async () => undefined),
    safeDb,
    userId: toSafeId<"user">(OWNER),
  });
};

describe("MCP gateway skill tools", () => {
  beforeEach(() => {
    captureErrorMock.mockReset();
  });

  test("namespaces each visible skill under the skill__ prefix", async () => {
    const context = createContext({
      rows: [skillRow({ slug: "alpha" }), skillRow({ slug: "beta" })],
    });

    const tools = await loadVisibleSkillTools({ context });

    expect(tools.map((tool) => tool.exposedName)).toEqual([
      "skill__alpha",
      "skill__beta",
    ]);
  });

  test("a private skill shadows a team skill with the same slug", async () => {
    // Precedence is the security-relevant branch: a user's own private skill
    // must win over a team skill sharing its slug, never the reverse.
    const context = createContext({
      rows: [
        skillRow({
          slug: "shared",
          scope: "team",
          userId: "user_other",
          body: "team-body",
        }),
        skillRow({ slug: "shared", scope: "private", body: "private-body" }),
      ],
    });

    const tools = await loadVisibleSkillTools({ context });

    expect(tools).toHaveLength(1);
    expect(tools.at(0)?.scope).toBe("private");
    expect(tools.at(0)?.body).toBe("private-body");
  });

  test("distinct slugs that sanitize to the same name get collision-safe names", async () => {
    // `data.report` and `data_report` are different slugs (no dedupe) but both
    // namespace to `skill__data_report`; the second must be disambiguated so a
    // dispatch by name can never resolve to the wrong skill.
    const context = createContext({
      rows: [
        skillRow({ slug: "data.report", body: "dotted" }),
        skillRow({ slug: "data_report", body: "underscored" }),
      ],
    });

    const tools = await loadVisibleSkillTools({ context });

    const names = tools.map((tool) => tool.exposedName);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("skill__data_report");
    expect(names.some((name) => name.startsWith("skill__data_report_"))).toBe(
      true,
    );
  });

  test("never exposes more skills than the gateway cap", async () => {
    const rows = Array.from(
      { length: LIMITS.mcpGatewaySkillsMax + 5 },
      (_, i) => skillRow({ slug: `skill-${i}` }),
    );
    const context = createContext({ rows });

    const tools = await loadVisibleSkillTools({ context });

    expect(tools).toHaveLength(LIMITS.mcpGatewaySkillsMax);
  });

  test("returns an empty list and captures the error when the DB read fails", async () => {
    const dbError = new Error("db unavailable");
    const context = createContext({ dbError });

    const tools = await loadVisibleSkillTools({ context });

    expect(tools).toEqual([]);
    expect(captureErrorMock).toHaveBeenCalledWith(dbError, {
      source: "mcp-gateway-skills",
    });
  });

  test("resolveSkillTool finds a skill by its exposed name", async () => {
    const context = createContext({
      rows: [skillRow({ slug: "alpha" }), skillRow({ slug: "beta" })],
    });

    const resolved = await resolveSkillTool({
      context,
      toolName: "skill__beta",
    });

    expect(resolved?.slug).toBe("beta");
    expect(resolved?.exposedName).toBe("skill__beta");
  });

  test("resolveSkillTool returns null for an unknown exposed name", async () => {
    const context = createContext({ rows: [skillRow({ slug: "alpha" })] });

    expect(
      await resolveSkillTool({ context, toolName: "skill__missing" }),
    ).toBeNull();
  });
});

// NOT covered here (needs a live Postgres, Docker is down): the WHERE-clause
// visibility gate itself (organization scoping, `enabled = true`, and the
// `scope = 'team' OR userId = <caller>` predicate). Those filters run in the
// database, so a mocked query builder returns whatever rows it is handed and
// cannot prove the predicate. They belong in an integration test against a real
// DB. The `stella:skills` OAuth-scope gate lives in `gateway/list-tools.ts`, not
// this module, and is a separate seam.
