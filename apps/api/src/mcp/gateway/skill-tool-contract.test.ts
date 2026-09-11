import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { SKILL_TOOL_OUTPUT } from "@/api/mcp/gateway/dynamic-tool-policy";
import {
  externalToolDefinition,
  toMcpTools,
} from "@/api/mcp/gateway/list-tools";
import type { SkillToolRow } from "@/api/mcp/gateway/skills";
import { handleMcpToolCall, listMcpTools } from "@/api/mcp/tools";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * End-to-end contract of the `skill__*` family through the served surface:
 * `tools/list` (`listMcpTools`) and `tools/call` (`handleMcpToolCall`) with a
 * fake backing store. Skill names are account-specific and may carry a
 * collision suffix, so every assertion runs over whatever names the real
 * precedence step produced rather than a hard-coded example.
 */

const OWNER = toSafeId<"user">("user_owner");

const skillRow = (
  overrides: Partial<SkillToolRow> & { slug: string },
): SkillToolRow => ({
  id: toSafeId<"agentSkill">(`skill_${overrides.slug}`),
  scope: "private",
  userId: OWNER,
  name: overrides.slug,
  description: `Instructions for ${overrides.slug}`,
  version: "1.0.0",
  license: null,
  compatibility: null,
  metadata: { author: "team" },
  body: `# ${overrides.slug}\n\nDo the thing.`,
  origin: "authored",
  ...overrides,
});

const upstreamTool = {
  description: "Look up a company by registration number",
  exposedName: "mcp__registry__lookup",
  inputSchema: {
    type: "object",
    properties: { number: { type: "string" } },
    required: ["number"],
  },
  rawName: "lookup",
  readOnlyHint: true,
} satisfies CachedMcpToolDefinition;

// The fake tx mirrors the real skill query chain
// (`select().from().where().orderBy().limit()`); only the terminal `.limit()`
// resolves, to the canned rows. Scoping is Postgres' job and is covered
// elsewhere.
const createSelectBuilder = (rows: readonly SkillToolRow[]) => {
  const builder = {
    from: () => builder,
    limit: async () => rows,
    orderBy: () => builder,
    where: () => builder,
  };
  return builder;
};

const createContext = (rows: readonly SkillToolRow[]): McpRequestContext => {
  const tx = { select: () => createSelectBuilder(rows) };
  const safeDb: McpRequestContext["safeDb"] = async (run) =>
    Result.ok(await run(asTestRaw<Transaction>(tx)));
  return asTestRaw<McpRequestContext>({
    enabledRegistrySlugs: undefined,
    grantedScopes: [],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw<AuditRecorder>(async () => undefined),
    safeDb,
    userId: OWNER,
  });
};

// `data.report` and `data_report` are distinct slugs that namespace to the
// same base name, so the second one is served under a collision suffix.
const skillRows = [
  skillRow({ slug: "summarize-c4ec37", name: "Summarize" }),
  skillRow({ slug: "data.report", body: "dotted" }),
  skillRow({ slug: "data_report", body: "underscored" }),
];

const listSkillTools = async () =>
  (
    await listMcpTools(createContext(skillRows), "default", ["stella:skills"])
  ).filter((tool) => tool.name.startsWith("skill__"));

describe("skill tool output contract", () => {
  let analytics: RecordingAnalytics;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
  });

  afterEach(() => {
    analytics.restore();
  });

  test("tools/list advertises the shared skill outputSchema for every served skill name", async () => {
    const tools = await listSkillTools();

    const names = tools.map((tool) => tool.name);
    expect(names).toHaveLength(skillRows.length);
    expect(names).toContain("skill__data_report");
    expect(names.some((name) => name.startsWith("skill__data_report_"))).toBe(
      true,
    );
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toEqual(
        SKILL_TOOL_OUTPUT.outputSchema,
      );
    }
  });

  test("every skill tool is read-only, non-destructive and closed-world", async () => {
    const tools = await listSkillTools();

    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: true,
      });
    }
  });

  test("a skill call serves structuredContent that satisfies the advertised contract", async () => {
    const tools = await listSkillTools();
    const suffixed = tools.find((tool) =>
      tool.name.startsWith("skill__data_report_"),
    );
    if (suffixed === undefined) {
      throw new Error("expected a collision-suffixed skill tool");
    }

    const result = await handleMcpToolCall({
      args: {},
      context: createContext(skillRows),
      toolName: suffixed.name,
    });

    expect(result.isError).toBeUndefined();
    const expected = {
      body: "underscored",
      compatibility: null,
      license: null,
      metadata: { author: "team" },
      name: "data_report",
      origin: "authored",
      version: "1.0.0",
    };
    expect(result.structuredContent).toEqual(expected);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(expected) },
    ]);
    expect(
      v.safeParse(
        SKILL_TOOL_OUTPUT.outputSchemaSource,
        result.structuredContent,
      ).success,
    ).toBe(true);
  });

  test("a stored skill whose projection violates the contract fails through the internal_error envelope", async () => {
    // jsonb metadata is typed as string values but the store cannot enforce
    // it; a non-string value must never reach a client as structuredContent.
    const malformed = asTestRaw<SkillToolRow>({
      ...skillRow({ slug: "summarize-c4ec37" }),
      metadata: { author: 1 },
    });
    expect(
      v.safeParse(SKILL_TOOL_OUTPUT.outputSchemaSource, {
        body: malformed.body,
        compatibility: null,
        license: null,
        metadata: malformed.metadata,
        name: malformed.slug,
        origin: "authored",
        version: "1.0.0",
      }).success,
    ).toBe(false);

    const result = await handleMcpToolCall({
      args: {},
      context: createContext([malformed]),
      toolName: "skill__summarize-c4ec37",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const item = result.content.at(0);
    const parsed: unknown =
      item?.type === "text" ? JSON.parse(item.text) : undefined;
    expect(parsed).toMatchObject({
      error: { code: "internal_error", message: "Tool execution failed" },
    });
    expect(analytics.exceptions()).toHaveLength(1);
  });
});

describe("third-party connector tools keep their upstream contract", () => {
  test("the wire definition is the cached upstream one, with no stella outputSchema", () => {
    const external = toMcpTools([
      externalToolDefinition({
        cachedTool: upstreamTool,
        connectorDisplayName: "Registry",
      }),
    ]).at(0);
    if (external === undefined) {
      throw new Error("expected the connector tool to be projected");
    }

    expect("outputSchema" in external).toBe(false);
    expect(external.name).toBe(upstreamTool.exposedName);
    expect(external.inputSchema).toEqual(upstreamTool.inputSchema);
    expect(external.annotations).toMatchObject({
      destructiveHint: false,
      openWorldHint: true,
      readOnlyHint: true,
    });
  });
});
