import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { McpRequestContext } from "@/api/mcp/context";
import { McpGatewayLoadError } from "@/api/mcp/errors";
import {
  listBuiltInSkillTools,
  loadVisibleSkillTools,
  resolveSkillTool,
} from "@/api/mcp/gateway/skills";
import type { ResolvedSkillTool } from "@/api/mcp/gateway/skills";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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

const installedOnly = (tools: readonly ResolvedSkillTool[]) =>
  tools.filter((tool) => tool.source === "installed");

// Every organization has the shipped skills, with no row.
const BUILT_IN = listBuiltInSkillTools().at(0);

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
  dbError?: DatabaseError;
  rows?: readonly SkillRow[];
} = {}): McpRequestContext => {
  const tx = { select: () => createSelectBuilder(rows) };
  const safeDb: McpRequestContext["safeDb"] = async (run) => {
    if (dbError) {
      return Result.err(dbError);
    }
    return Result.ok(await run(asTestRaw<Transaction>(tx)));
  };

  return asTestRaw<McpRequestContext>({
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw<AuditRecorder>(async () => undefined),
    safeDb,
    userId: toSafeId<"user">(OWNER),
  });
};

describe("MCP gateway skill tools", () => {
  let analytics: RecordingAnalytics;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
  });

  afterEach(() => {
    analytics.restore();
  });

  test("namespaces each visible skill under the skill__ prefix", async () => {
    const context = createContext({
      rows: [skillRow({ slug: "alpha" }), skillRow({ slug: "beta" })],
    });

    const tools = await loadVisibleSkillTools({ context });

    expect(installedOnly(tools).map((tool) => tool.exposedName)).toEqual([
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

    const tools = installedOnly(await loadVisibleSkillTools({ context }));

    expect(tools).toHaveLength(1);
    const [shared] = tools;
    expect(shared?.source === "installed" && shared.scope).toBe("private");
    expect(shared?.body).toBe("private-body");
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

    const tools = installedOnly(await loadVisibleSkillTools({ context }));

    const names = tools.map((tool) => tool.exposedName);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("skill__data_report");
    expect(names.some((name) => name.startsWith("skill__data_report_"))).toBe(
      true,
    );
  });

  const builtInSlugs = (tools: readonly ResolvedSkillTool[]) =>
    tools.filter(({ source }) => source === "built-in").map(({ slug }) => slug);

  test("caps installed skills at the gateway cap and still serves every built-in", async () => {
    const rows = Array.from(
      { length: LIMITS.mcpGatewaySkillsMax + 5 },
      (_, i) => skillRow({ slug: `skill-${i}` }),
    );
    const context = createContext({ rows });
    const logs = installRecordingLogger();

    try {
      const tools = await loadVisibleSkillTools({ context });

      expect(installedOnly(tools)).toHaveLength(LIMITS.mcpGatewaySkillsMax);
      expect(builtInSlugs(tools)).toEqual(
        listBuiltInSkillTools().map(({ slug }) => slug),
      );
      expect(logs.at("WARN")).toMatchObject([
        {
          message: "mcp.gateway.skills_capped",
          attributes: {
            "organization.id": context.organizationId,
            "skills.cap": LIMITS.mcpGatewaySkillsMax,
            "skills.dropped": 5,
          },
        },
      ]);
    } finally {
      logs.restore();
    }
  });

  test("an installed skill within the cap still shadows the built-in with its slug", async () => {
    const builtIn = BUILT_IN ?? panic("no built-in skill ships");
    const rows = [
      skillRow({ slug: builtIn.slug, body: "installed-body" }),
      ...Array.from({ length: LIMITS.mcpGatewaySkillsMax + 4 }, (_, i) =>
        skillRow({ slug: `skill-${i}` }),
      ),
    ];
    const context = createContext({ rows });
    const logs = installRecordingLogger();

    try {
      const tools = await loadVisibleSkillTools({ context });

      const matching = tools.filter(({ slug }) => slug === builtIn.slug);
      expect(matching).toHaveLength(1);
      expect(matching.at(0)?.source).toBe("installed");
      expect(installedOnly(tools)).toHaveLength(LIMITS.mcpGatewaySkillsMax);
      expect(builtInSlugs(tools)).toEqual(
        listBuiltInSkillTools()
          .map(({ slug }) => slug)
          .filter((slug) => slug !== builtIn.slug),
      );
    } finally {
      logs.restore();
    }
  });

  test("an installed skill the cap drops does not shadow the built-in with its slug", async () => {
    const builtIn = BUILT_IN ?? panic("no built-in skill ships");
    // Private rows sort first, so the team row with the built-in's slug is
    // the one past the cap.
    const rows = [
      ...Array.from({ length: LIMITS.mcpGatewaySkillsMax }, (_, i) =>
        skillRow({ slug: `skill-${i}` }),
      ),
      skillRow({
        slug: builtIn.slug,
        scope: "team",
        userId: "user_other",
        body: "installed-body",
      }),
    ];
    const context = createContext({ rows });
    const logs = installRecordingLogger();

    try {
      const tools = await loadVisibleSkillTools({ context });

      const matching = tools.filter(({ slug }) => slug === builtIn.slug);
      expect(matching).toHaveLength(1);
      expect(matching.at(0)?.source).toBe("built-in");
      expect(matching.at(0)?.body).toBe(builtIn.body);
      expect(logs.at("WARN")).toMatchObject([
        { attributes: { "skills.dropped": 1 } },
      ]);
    } finally {
      logs.restore();
    }
  });

  test("serves the built-in skills with no agent_skills row", async () => {
    const builtIn = BUILT_IN ?? panic("no built-in skill ships");
    const context = createContext();

    const tools = await loadVisibleSkillTools({ context });

    expect(tools.map(({ slug }) => slug)).toEqual(
      listBuiltInSkillTools().map(({ slug }) => slug),
    );
    const resolved = tools.find(({ slug }) => slug === builtIn.slug);
    expect(resolved?.source).toBe("built-in");
    expect(resolved?.body).toBe(builtIn.body);
    expect(
      await resolveSkillTool({
        context,
        toolName: resolved?.exposedName ?? "",
      }),
    ).toEqual(resolved ?? null);
  });

  test("an installed skill shadows a built-in with the same slug", async () => {
    const builtIn = BUILT_IN ?? panic("no built-in skill ships");
    const context = createContext({
      rows: [
        skillRow({
          slug: builtIn.slug,
          scope: "team",
          userId: "user_other",
          body: "installed-body",
        }),
      ],
    });

    const tools = await loadVisibleSkillTools({ context });

    const matching = tools.filter(({ slug }) => slug === builtIn.slug);
    expect(matching).toHaveLength(1);
    expect(matching.at(0)?.source).toBe("installed");
    expect(matching.at(0)?.body).toBe("installed-body");
  });

  test("propagates a load fault (captured, not swallowed) instead of an empty list when the DB read fails", async () => {
    // A DB outage must not be mistaken for "no skills": the loader throws a
    // distinct fault so tools/list fails loudly rather than silently dropping
    // every skill tool. bun-types declares `.rejects.toThrow` as void, so
    // awaiting it trips type-aware lint; capture the rejection explicitly
    // instead (mirrors external-tools.test.ts's load-fault assertion).
    const dbError = new DatabaseError({ message: "db unavailable" });
    const context = createContext({ dbError });

    const rejection: unknown = await loadVisibleSkillTools({ context }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(McpGatewayLoadError);
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      { "error.class": "DatabaseError", source: "mcp-gateway-skills" },
    ]);
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
