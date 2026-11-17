import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import { rootDb } from "@/api/db/root";
import { agentSkills, auditLogs } from "@/api/db/schema";
import { buildGlobalPromptParts } from "@/api/handlers/chat/chat-prompt";
import { LOCAL_RUN_MCP_MODE } from "@/api/handlers/chat/local-run-plan";
import { loadLocalRunSkillTools } from "@/api/handlers/chat/local-run-skills";
import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import { getAuth } from "@/api/lib/auth";
import {
  getAuthEndpointUrl,
  getAuthIssuerUrl,
} from "@/api/lib/auth/auth-paths";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  isSkillToolName,
  namespaceSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import { mintAgentRunToken } from "@/api/mcp/agent-run-token";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { handleMcpHttpRequest } from "@/api/mcp/server";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

// timeout: each test signs a member in, creates an organization and signs
// tokens against the in-process auth database, which takes longer than the
// default budget on a loaded runner (as session-context-query-plan does).
setDefaultTimeout(120_000);

// The MCP route as production mounts it, without the transport rate limit
// (a budget store this suite does not run).
const server = serveRoutesForTest(createMcpRoute({ handleMcpHttpRequest }));

// The verifier loads the signing keys over HTTP; serve that one address from
// the real auth handler so the token path runs unchanged.
const testFetchState = createTestFetch();
const passThroughFetch = globalThis.fetch;
testFetchState.set(
  Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
      return request.url === getAuthEndpointUrl("jwks")
        ? await getAuth().handler(request)
        : await passThroughFetch(input, init);
    },
    { preconnect: passThroughFetch.preconnect },
  ),
);

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await server.stop();
  testFetchState.restore();
  await releaseAgentAuthTestDb();
});

const jsonRpcResultSchema = v.looseObject({
  result: v.looseObject({
    tools: v.optional(v.array(v.looseObject({ name: v.string() }))),
    isError: v.optional(v.boolean()),
    structuredContent: v.optional(v.unknown()),
    content: v.optional(v.array(v.unknown())),
  }),
});

/** One JSON-RPC call at the MCP address a run on the computer is handed. */
const callLocalRunMcp = async (
  token: string,
  method: "tools/list" | "tools/call",
  params: Record<string, unknown> = {},
) => {
  const response = await server.fetch(
    new Request(getMcpResourceUrl(LOCAL_RUN_MCP_MODE), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return v.parse(jsonRpcResultSchema, await response.json()).result;
};

const listedSkillToolNames = async (token: string) =>
  ((await callLocalRunMcp(token, "tools/list")).tools ?? [])
    .map(({ name }) => name)
    .filter(isSkillToolName);

const signDelegatedUserToken = async (
  userId: string,
  organizationId: string,
): Promise<string> => {
  const nowSeconds = Math.floor(
    Temporal.Now.instant().epochMilliseconds / 1000,
  );
  const { token } = await getAuth().api.signJWT({
    body: {
      payload: {
        sub: userId,
        org_id: organizationId,
        scope: MCP_DEFAULT_RESOURCE_SCOPES.join(" "),
        aud: getMcpResourceUrl(),
        iss: getAuthIssuerUrl(),
        iat: nowSeconds,
        exp: nowSeconds + 600,
      },
    },
  });
  return token;
};

const insertSkill = async ({
  organizationId,
  slug,
  userId,
  ...row
}: {
  organizationId: SafeId<"organization">;
  slug: string;
  userId: SafeId<"user">;
} & Partial<
  Pick<
    typeof agentSkills.$inferInsert,
    "enabled" | "invocation" | "metadata" | "scope"
  >
>) => {
  const id = toSafeId<"agentSkill">(Bun.randomUUIDv7());
  await rootDb.insert(agentSkills).values({
    id,
    organizationId,
    userId,
    scope: "private",
    origin: "authored",
    slug,
    name: slug,
    description: `Use for ${slug}.`,
    metadata: {},
    contentHash: "0".repeat(64),
    body: `body of ${slug}`,
    enabled: true,
    ...row,
  });
  return id;
};

describe("a run on the member's computer reaches every skill over MCP", () => {
  test("its token lists the member's skills and stella's own as tools, and its prompt names exactly those", async () => {
    const owner = await signInHuman(`owner-${Bun.randomUUIDv7()}@stella.dev`);
    const organization = await getAuth().api.createOrganization({
      body: {
        name: "Local run skills",
        slug: `local-run-skills-${Bun.randomUUIDv7()}`,
      },
      headers: owner.headers(),
    });
    await owner.setActiveOrganization(organization.id);
    const organizationId = toSafeId<"organization">(organization.id);
    const userId = owner.userId;
    const skill = { organizationId, userId };

    await insertSkill({ ...skill, scope: "team", slug: "team-review" });
    await insertSkill({ ...skill, scope: "team", slug: "shared-method" });
    const privateCopy = await insertSkill({ ...skill, slug: "shared-method" });
    await insertSkill({ ...skill, enabled: false, slug: "switched-off" });
    await insertSkill({ ...skill, invocation: "manual", slug: "on-request" });
    await insertSkill({
      ...skill,
      metadata: { "stella-required-tools": "list_matters" },
      slug: "needs-matters",
    });
    await insertSkill({
      ...skill,
      metadata: { "stella-required-tools": "no_such_tool" },
      slug: "needs-missing",
    });

    const runId = Bun.randomUUIDv7();
    const { token } = await mintAgentRunToken({
      organizationId,
      runId,
      userId,
      workspaceIds: [],
    });
    const listed = await listedSkillToolNames(token);

    for (const slug of ["team-review", "shared-method", "needs-matters"]) {
      expect(listed).toContain(namespaceSkillToolName(slug));
    }
    for (const slug of ["switched-off", "on-request", "needs-missing"]) {
      expect(listed).not.toContain(namespaceSkillToolName(slug));
    }
    expect(listed).toContain(namespaceSkillToolName("playbook-builder"));
    // A private skill shadows the team one with its slug: one tool.
    expect(
      listed.filter((name) => name === namespaceSkillToolName("shared-method")),
    ).toHaveLength(1);

    // An ordinary client on the same address gets no skill tools.
    expect(
      await listedSkillToolNames(
        await signDelegatedUserToken(userId, organizationId),
      ),
    ).toEqual([]);

    // The turn's prompt lists the same tools, read the way the run's session
    // reads them.
    const skillTools = (
      await loadLocalRunSkillTools({
        organizationId,
        runId,
        userId,
        workspaceIds: [],
      })
    ).unwrap();
    expect(skillTools.map(({ toolName }) => toolName).toSorted()).toEqual(
      listed.toSorted(),
    );
    const prompt = buildGlobalPromptParts({
      promptTarget: { type: "local_run", webSearch: "unasked", skillTools },
      userContext: null,
    }).fullPrompt;
    expect(
      [...prompt.matchAll(/^- (skill__[a-z0-9_]+)/gmu)]
        .map((match) => match[1])
        .toSorted(),
    ).toEqual(listed.toSorted());
    expect(prompt).not.toContain("load-skill");

    // Calling a skill's tool reads it and audits the read.
    const toolName = namespaceSkillToolName("shared-method");
    const read = await callLocalRunMcp(token, "tools/call", {
      name: toolName,
      arguments: {},
    });
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toMatchObject({
      body: "body of shared-method",
      id: privateCopy,
      type: "skill",
    });
    const audited = await rootDb
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, privateCopy));
    expect(audited.map(({ metadata }) => metadata)).toEqual([
      expect.objectContaining({ outcome: "success", surface: "mcp" }),
    ]);

    // Disabled after the run listed it: the call names an unknown tool.
    await rootDb
      .update(agentSkills)
      .set({ enabled: false })
      .where(
        and(
          eq(agentSkills.organizationId, organizationId),
          eq(agentSkills.slug, "team-review"),
        ),
      );
    const gone = await callLocalRunMcp(token, "tools/call", {
      name: namespaceSkillToolName("team-review"),
      arguments: {},
    });
    expect(gone.isError).toBe(true);
    expect(JSON.stringify(gone.content)).toContain("unknown_tool");
  });
});
