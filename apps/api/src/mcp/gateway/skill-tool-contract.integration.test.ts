import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { agentSkills } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { SKILL_TOOL_OUTPUT } from "@/api/mcp/gateway/dynamic-tool-policy";
import {
  externalToolDefinition,
  toMcpTools,
} from "@/api/mcp/gateway/list-tools";
import { handleMcpToolCall, listMcpTools } from "@/api/mcp/tools";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * End-to-end contract of the `skill__*` family through the served surface:
 * `tools/list` (`listMcpTools`) and `tools/call` (`handleMcpToolCall`) over
 * the real skill store. Skill names are account-specific and may carry a
 * collision suffix, so every assertion runs over whatever names the real
 * naming step produced rather than a hard-coded example.
 */

const testId = <T extends SafeIdType>() => toSafeId<T>(Bun.randomUUIDv7());

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = async (callback) =>
    await Result.tryPromise(
      async () => await callback(asTestRaw<Transaction>(testDb)),
    );
});

afterAll(async () => {
  await releaseRlsFixture();
});

// One run id keeps this file's skills apart from the ones other suites put in
// the shared organization.
const RUN = Bun.randomUUIDv7().slice(-12);

const insertSkill = async ({
  body = "Do the thing.",
  metadata = { author: "team" },
  name,
  slug,
}: {
  body?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  slug: string;
}) => {
  await testDb.insert(agentSkills).values({
    id: testId<"agentSkill">(),
    organizationId: ids.orgA,
    userId: ids.userA1,
    scope: "private",
    origin: "authored",
    slug,
    name: name ?? slug,
    description: `Instructions for ${slug}`,
    version: "1.0.0",
    metadata: asTestRaw<Record<string, string>>(metadata),
    contentHash: "0".repeat(64),
    body,
    enabled: true,
  });
};

const createContext = (): McpRequestContext =>
  asTestRaw<McpRequestContext>({
    enabledRegistrySlugs: undefined,
    grantedScopes: [],
    memberRole: "owner",
    organizationId: ids.orgA,
    recordAuditEvent: asTestRaw<AuditRecorder>(async () => undefined),
    safeDb,
    userId: ids.userA1,
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

// `data.report-…` and `data_report-…` are distinct slugs that namespace to the
// same base name, so one of them is served under a collision suffix.
const SUMMARIZE_SLUG = `summarize-${RUN}`;
const DOTTED_SLUG = `data.report-${RUN}`;
const UNDERSCORED_SLUG = `data_report-${RUN}`;
const MALFORMED_SLUG = `malformed-${RUN}`;
const COLLIDING_NAME = `skill__data_report-${RUN}`;

const listSkillTools = async () =>
  (await listMcpTools(createContext(), "default", ["stella:skills"])).filter(
    (tool) => tool.name.startsWith("skill__") && tool.name.includes(RUN),
  );

describe("skill tool output contract", () => {
  let analytics: RecordingAnalytics;

  beforeAll(async () => {
    await insertSkill({ slug: SUMMARIZE_SLUG, name: "Summarize" });
    await insertSkill({ slug: DOTTED_SLUG, body: "dotted" });
    await insertSkill({ slug: UNDERSCORED_SLUG, body: "underscored" });
    // jsonb metadata is typed as string values but the store cannot enforce
    // it; a non-string value must never reach a client as structuredContent.
    await insertSkill({ slug: MALFORMED_SLUG, metadata: { author: 1 } });
  });

  beforeEach(() => {
    analytics = installRecordingAnalytics();
  });

  afterEach(() => {
    analytics.restore();
  });

  test("tools/list advertises the shared skill outputSchema for every served skill name", async () => {
    const tools = await listSkillTools();

    const names = tools.map((tool) => tool.name);
    expect(names).toHaveLength(4);
    expect(names).toContain(COLLIDING_NAME);
    expect(names.some((name) => name.startsWith(`${COLLIDING_NAME}_`))).toBe(
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
      tool.name.startsWith(`${COLLIDING_NAME}_`),
    );
    if (suffixed === undefined) {
      throw new Error("expected a collision-suffixed skill tool");
    }

    const result = await handleMcpToolCall({
      args: {},
      context: createContext(),
      toolName: suffixed.name,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      compatibility: null,
      license: null,
      metadata: { author: "team" },
      origin: "authored",
      version: "1.0.0",
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
    expect(
      v.safeParse(
        SKILL_TOOL_OUTPUT.outputSchemaSource,
        result.structuredContent,
      ).success,
    ).toBe(true);
  });

  test("a stored skill whose projection violates the contract fails through the internal_error envelope", async () => {
    const result = await handleMcpToolCall({
      args: {},
      context: createContext(),
      toolName: `skill__${MALFORMED_SLUG}`,
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
