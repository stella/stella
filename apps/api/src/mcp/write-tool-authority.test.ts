import { describe, expect, test } from "bun:test";

import { roles } from "@stll/permissions";

import type { ScopedDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { buildChatWriteTools } from "@/api/handlers/chat/tools/registry-write-tools";
import { checkDemoAccountAccess } from "@/api/lib/auth/demo-account-policy";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole, type MemberRole } from "@/api/lib/member-roles";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { MCP_MODES } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { listOfferedStaticMcpToolDefinitions } from "@/api/mcp/gateway/static-tool-visibility";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";
import { handleMcpToolCall } from "@/api/mcp/tools";
import {
  isAccountAuthorizedForMcpTool,
  isMemberAuthorizedForMcpTool,
  type McpToolAuthorityDeclaration,
} from "@/api/mcp/write-tool-authority";
import { callMcpToolOverHttp } from "@/api/tests/helpers/mcp-http-tool-call";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import ledger from "./write-tool-authority-ledger.json" with { type: "json" };

const MEMBER_ROLES: readonly MemberRole[] =
  Object.keys(roles).filter(isMemberRole);

/** Every static write tool on every MCP surface, once per name. */
const writeDefinitions = (): McpToolDefinition[] => {
  const byName = new Map<string, McpToolDefinition>();
  for (const mode of MCP_MODES) {
    for (const definition of listStaticMcpToolDefinitions(mode)) {
      if (definition.access === "write") {
        byName.set(definition.name, definition);
      }
    }
  }
  return [...byName.values()].toSorted((left, right) =>
    left.name < right.name ? -1 : 1,
  );
};

const mcpContextFor = (role: MemberRole): McpRequestContext =>
  asTestRaw<McpRequestContext>({
    featureAccessSnapshot: enrolledTimeBillingSnapshot({
      organizationId: "org_1",
      userId: "user_1",
    }),
    organizationId: toSafeId<"organization">("org_1"),
    userId: toSafeId<"user">("user_1"),
    userEmail: "member@example.test",
    accessibleWorkspaceIds: [],
    enabledRegistrySlugs: undefined,
    grantedScopes: [],
    memberRole: role,
  });

/**
 * The guard: every tool a role is offered must be one its declared
 * permissions authorize. `offered` is the surface under test, so the
 * self-test can hand it a surface whose gate is missing.
 */
const unauthorizedOffers = (
  definitions: readonly (McpToolAuthorityDeclaration & { name: string })[],
  offered: (role: MemberRole) => ReadonlySet<string>,
): string[] =>
  MEMBER_ROLES.flatMap((role) => {
    const names = offered(role);
    return definitions
      .filter(
        (definition) =>
          names.has(definition.name) &&
          !isMemberAuthorizedForMcpTool(sessionMemberRole(role), definition),
      )
      .map((definition) => `${role} is offered ${definition.name}`);
  });

const mcpOffered = (role: MemberRole): ReadonlySet<string> =>
  new Set(
    MCP_MODES.flatMap((mode) =>
      listOfferedStaticMcpToolDefinitions({
        context: mcpContextFor(role),
        mode,
      }).map((definition) => definition.name),
    ),
  );

const noopScopedDb = asTestRaw<ScopedDb>(
  async (run: (tx: unknown) => unknown) => await run({}),
);

const chatWriteTools = (
  role: MemberRole,
  currentRole: MemberRole | null = role,
) =>
  buildChatWriteTools({
    featureAccessSnapshot: enrolledTimeBillingSnapshot({
      organizationId: "org_1",
      userId: "user_1",
    }),
    memberRole: sessionMemberRole(role),
    organizationId: toSafeId<"organization">("org_1"),
    pinServerValidatedWorkspaceId: () => true,
    refRegistry: createChatRefRegistry(),
    resolveCurrentMembership: async () =>
      currentRole === null ? null : { role: currentRole },
    safeDb: toSafeDbMock(noopScopedDb),
    scopedDb: noopScopedDb,
    toolDefectMemo: createChatToolDefectMemo(),
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: [],
      pinnedIds: [],
    }),
    userEmail: "member@example.test",
    userId: toSafeId<"user">("user_1"),
    workspaceStatusById: new Map(),
  });

/** Run a registered chat write tool and return the refusal it throws, if any. */
const chatExecutionFailure = async ({
  args,
  currentRole,
  registeredRole,
  tool,
}: {
  args: Record<string, unknown>;
  currentRole: MemberRole | null;
  registeredRole: MemberRole;
  tool: string;
}): Promise<unknown> => {
  const execute = chatWriteTools(registeredRole, currentRole)[tool]?.execute;
  if (execute === undefined) {
    throw new Error(`${tool} must be registered for ${registeredRole}`);
  }
  return await Promise.resolve(execute(args)).then(
    () => null,
    (error: unknown) => error,
  );
};

const chatOffered = (role: MemberRole): ReadonlySet<string> =>
  new Set(Object.keys(chatWriteTools(role)));

const ledgerId = (definition: McpToolDefinition): string | null => {
  if (definition.access !== "write") {
    return null;
  }
  const { type } = definition.permissions;
  return type === "all" || type === "input"
    ? null
    : `${definition.name}::${type}`;
};

describe("write tool permissions", () => {
  test("enrolled principals exercise every feature-bound write tool's authority", () => {
    const featureBoundWrites = writeDefinitions().filter(
      (definition) => definition.featureId !== undefined,
    );
    expect(featureBoundWrites.length).toBeGreaterThan(0);
    for (const role of MEMBER_ROLES) {
      const offered = mcpOffered(role);
      for (const definition of featureBoundWrites) {
        expect(
          offered.has(definition.name),
          `${role}: ${definition.name}`,
        ).toBe(
          isMemberAuthorizedForMcpTool(sessionMemberRole(role), definition),
        );
      }
    }
  });

  test("every write tool declares an authority some role can hold", () => {
    const definitions = writeDefinitions();
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      if (definition.access !== "write") {
        continue;
      }
      const { permissions } = definition;
      expect(["all", "input", "any", "delegated"]).toContain(permissions.type);
      expect(["standard", "sandbox", "account-control"]).toContain(
        definition.accountAccess,
      );
      if (permissions.type === "any" || permissions.type === "delegated") {
        expect(permissions.reason.trim().length).toBeGreaterThan(0);
      }
      // An unsatisfiable declaration would hide the tool from everyone.
      expect({
        name: definition.name,
        owner: isMemberAuthorizedForMcpTool(
          sessionMemberRole("owner"),
          definition,
        ),
      }).toEqual({ name: definition.name, owner: true });
    }
  });

  test("declarations weaker than one exact grant are exactly the ledger", () => {
    const current = writeDefinitions()
      .map(ledgerId)
      .filter((id): id is string => id !== null)
      .toSorted();
    expect(current).toEqual(ledger.map((row) => row.id).toSorted());
    for (const row of ledger) {
      expect(row.reason.trim().length).toBeGreaterThan(0);
    }
  });

  test("MCP discovery offers no role a write tool its permissions do not grant", () => {
    expect(unauthorizedOffers(writeDefinitions(), mcpOffered)).toEqual([]);
  });

  test("chat registers no role a write tool its permissions do not grant", () => {
    expect(unauthorizedOffers(writeDefinitions(), chatOffered)).toEqual([]);
  });

  test("the gate withholds a write tool from a role without its grant", () => {
    expect(mcpOffered("external").has("delete_matter")).toBe(false);
    expect(chatOffered("external").has("delete_matter")).toBe(false);
    expect(mcpOffered("owner").has("delete_matter")).toBe(true);
  });

  /**
   * Both ways a call reaches dispatch: the direct entry point (evals, the
   * role matrix) and the HTTP transport every MCP client and the CLI use.
   */
  const TRANSPORTS = {
    dispatch: handleMcpToolCall,
    http: async (options: Parameters<typeof handleMcpToolCall>[0]) =>
      await callMcpToolOverHttp({ ...options, mode: "default" }),
  } as const;

  const TRANSPORT_NAMES = Object.keys(TRANSPORTS).filter(
    (name): name is keyof typeof TRANSPORTS => name in TRANSPORTS,
  );

  const refusalOver = async ({
    context,
    transport,
  }: {
    context: McpRequestContext;
    transport: keyof typeof TRANSPORTS;
  }): Promise<unknown> => {
    const result = await TRANSPORTS[transport]({
      args: { matter_id: "matter_1", confirm: true },
      context,
      toolName: "delete_matter",
    });
    expect(result.isError).toBe(true);
    const item = result.content.at(0);
    return item?.type === "text" ? JSON.parse(item.text) : null;
  };

  test.each(TRANSPORT_NAMES)(
    "a call by name over %s refuses a write tool the role cannot hold before its handler runs",
    async (transport) => {
      expect(
        await refusalOver({
          context: mcpContextFor("external"),
          transport,
        }),
      ).toEqual({
        error: {
          code: "permission_denied",
          message: "Your member role does not permit delete_matter",
          hint: "Call tools/list for the tools your role offers, or ask an organization administrator for a role that includes this tool.",
        },
      });
    },
  );

  test.each(TRANSPORT_NAMES)(
    "a call by name over %s names the credential when only its permissions refuse the tool",
    async (transport) => {
      expect(
        await refusalOver({
          context: asTestRaw<McpRequestContext>({
            ...mcpContextFor("owner"),
            credentialPermissions: { workspace: ["read"] },
          }),
          transport,
        }),
      ).toEqual({
        error: {
          code: "permission_denied",
          message: "This credential's permissions do not include delete_matter",
          hint: "Your member role allows this tool. Call it with a credential whose permissions include its grant, such as an API key minted with that permission.",
        },
      });
    },
  );

  // An admitted call counts against the caller's action budget even when
  // dispatch then refuses it, so the refusal must come first.
  test.each([
    { denial: "member-role", context: mcpContextFor("external") },
    {
      denial: "credential",
      context: asTestRaw<McpRequestContext>({
        ...mcpContextFor("owner"),
        credentialPermissions: { workspace: ["read"] },
      }),
    },
  ])(
    "over http a $denial refusal is answered before action admission",
    async ({ context }) => {
      let admissions = 0;
      const result = await callMcpToolOverHttp({
        admitAction: async () => {
          admissions += 1;
          return await Promise.reject(
            new Error("admission must not run for an unauthorized call"),
          );
        },
        args: { matter_id: "matter_1", confirm: true },
        context,
        mode: "default",
        toolName: "delete_matter",
      });
      expect(admissions).toBe(0);
      const item = result.content.at(0);
      expect(
        item?.type === "text" ? JSON.parse(item.text) : null,
      ).toMatchObject({ error: { code: "permission_denied" } });
    },
  );
});

describe("chat write tools re-read the member's role when they run", () => {
  const deleteMatter = {
    args: { matter_id: "matter_1", confirm: true },
    registeredRole: "owner",
    tool: "delete_matter",
  } as const;

  test("a role downgraded after registration is refused at execution", async () => {
    const failure = await chatExecutionFailure({
      ...deleteMatter,
      currentRole: "intern",
    });
    expect(failure).toBeInstanceOf(ChatToolError);
    expect(failure).toMatchObject({
      kind: "unavailable",
      message: "Your member role does not permit delete_matter.",
    });
  });

  test("a member removed after registration is refused at execution", async () => {
    const failure = await chatExecutionFailure({
      ...deleteMatter,
      currentRole: null,
    });
    expect(failure).toBeInstanceOf(ChatToolError);
    expect(failure).toMatchObject({
      kind: "unavailable",
      message: "You are no longer a member of this organization.",
    });
  });

  test("an unchanged role passes the gate and reaches the tool", async () => {
    const failure = await chatExecutionFailure({
      ...deleteMatter,
      currentRole: "owner",
    });
    // The matter is not in this caller's scope, so the tool itself answers;
    // the point is that the role gate let it through.
    expect(failure).not.toMatchObject({
      message: "Your member role does not permit delete_matter.",
    });
    expect(failure).not.toMatchObject({
      message: "You are no longer a member of this organization.",
    });
  });
});

describe("write tool permissions self-test", () => {
  const fixture = {
    access: "write",
    name: "fixture_update_entity",
    permissions: { type: "all", permissions: { entity: ["update"] } },
    accountAccess: "sandbox",
  } as const satisfies McpToolAuthorityDeclaration & { name: string };

  test("a surface offering a write tool to a role without its grant fails the guard", () => {
    const offersEverything = () => new Set([fixture.name]);
    expect(unauthorizedOffers([fixture], offersEverything)).toContain(
      "external is offered fixture_update_entity",
    );
  });

  test("a write definition without declared permissions does not compile", () => {
    // Identical literals; only `permissions` differs, so the expected error
    // can only be its absence.
    const declared: McpToolDefinition = {
      access: "write",
      annotations: {
        title: "Fixture",
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      anonymized: { exposure: "excluded", reason: "write" },
      consumesServices: false,
      description: "Fixture write tool",
      inputSchema: { type: "object" },
      name: "fixture_write",
      permissions: fixture.permissions,
      accountAccess: fixture.accountAccess,
      scope: "stella:read",
    };
    // @ts-expect-error -- the write branch requires `permissions`
    const undeclared: McpToolDefinition = {
      access: "write",
      annotations: {
        title: "Fixture",
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      anonymized: { exposure: "excluded", reason: "write" },
      consumesServices: false,
      description: "Fixture write tool",
      inputSchema: { type: "object" },
      name: "fixture_write",
      accountAccess: fixture.accountAccess,
      scope: "stella:read",
    };
    // @ts-expect-error -- the write branch requires `accountAccess`
    const undeclaredAccount: McpToolDefinition = {
      access: "write",
      annotations: {
        title: "Fixture",
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      anonymized: { exposure: "excluded", reason: "write" },
      consumesServices: false,
      description: "Fixture write tool",
      inputSchema: { type: "object" },
      name: "fixture_write",
      permissions: fixture.permissions,
      scope: "stella:read",
    };
    expect(undeclared.name).toBe(declared.name);
    expect(undeclaredAccount.name).toBe(declared.name);
  });
});

/** The JSON payload of an MCP tool result. */
const payloadOf = (result: Awaited<ReturnType<typeof handleMcpToolCall>>) => {
  const item = result.content.at(0);
  return item?.type === "text" ? (JSON.parse(item.text) as unknown) : null;
};

const OPERATION_DENIED = (tool: string) => ({
  error: {
    code: "permission_denied",
    message: `Your member role does not permit this ${tool} operation`,
    hint: "Call tools/list for the tools your role offers, or ask an organization administrator for a role that includes this tool.",
  },
});

// The role allows the operation; only the credential's own set refuses it.
const CREDENTIAL_OPERATION_DENIED = (tool: string) => ({
  error: {
    code: "permission_denied",
    message: `This credential's permissions do not include this ${tool} operation`,
    hint: "Your member role allows this tool. Call it with a credential whose permissions include its grant, such as an API key minted with that permission.",
  },
});

describe("write tools whose input selects the operation", () => {
  test("each selector reads a declared optional input, and a value selector covers its enum exactly", () => {
    const problems: string[] = [];
    for (const definition of writeDefinitions()) {
      if (
        definition.access !== "write" ||
        definition.permissions.type !== "input"
      ) {
        continue;
      }
      const { select } = definition.permissions;
      const property: unknown =
        definition.inputSchema.properties?.[select.property];
      if (property === undefined) {
        problems.push(`${definition.name}: no input ${select.property}`);
        continue;
      }
      const required: unknown = definition.inputSchema["required"];
      if (
        select.by === "presence" &&
        Array.isArray(required) &&
        required.includes(select.property)
      ) {
        problems.push(`${definition.name}: ${select.property} is required`);
      }
      if (select.by === "value") {
        const values =
          typeof property === "object" &&
          property !== null &&
          "enum" in property
            ? property.enum
            : undefined;
        expect({
          name: definition.name,
          values: Array.isArray(values)
            ? values
                .map(String)
                .toSorted((left, right) => (left < right ? -1 : 1))
            : values,
        }).toEqual({
          name: definition.name,
          values: Object.keys(select.values).toSorted(),
        });
      }
    }
    expect(problems).toEqual([]);
  });

  test("dispatch checks the grant of the selected operation before the handler runs", async () => {
    // A member may change matter membership but not organization settings.
    const settings = await handleMcpToolCall({
      args: { action: "update_org_settings", prompt_caching_enabled: true },
      context: mcpContextFor("member"),
      toolName: "manage_organization",
    });
    expect(payloadOf(settings)).toEqual(
      OPERATION_DENIED("manage_organization"),
    );

    const membership = await handleMcpToolCall({
      args: {
        action: "add_member",
        matter_id: "00000000-0000-4000-8000-000000000001",
        user_id: "user_2",
      },
      context: mcpContextFor("member"),
      toolName: "manage_organization",
    });
    expect(payloadOf(membership)).not.toEqual(
      OPERATION_DENIED("manage_organization"),
    );
  });

  test("dispatch refuses deleting a document to a credential that may only update it", async () => {
    const updateOnly = asTestRaw<McpRequestContext>({
      accessibleWorkspaceIds: [],
      credentialPermissions: { entity: ["update"] },
      enabledRegistrySlugs: undefined,
      grantedScopes: [],
      memberRole: "owner",
    });
    const document = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-000000000001",
        confirm: true,
      },
      context: updateOnly,
      toolName: "delete_document",
    });
    expect(payloadOf(document)).toEqual(
      CREDENTIAL_OPERATION_DENIED("delete_document"),
    );

    const version = await handleMcpToolCall({
      args: {
        entity_id: "00000000-0000-4000-8000-000000000001",
        version_id: "00000000-0000-4000-8000-000000000002",
        confirm: true,
      },
      context: updateOnly,
      toolName: "delete_document",
    });
    expect(payloadOf(version)).not.toEqual(
      CREDENTIAL_OPERATION_DENIED("delete_document"),
    );
  });

  test("chat execution checks the grant of the selected operation", async () => {
    const failure = await chatExecutionFailure({
      args: { action: "update_org_settings", prompt_caching_enabled: true },
      currentRole: "member",
      registeredRole: "member",
      tool: "manage_organization",
    });
    expect(failure).toBeInstanceOf(ChatToolError);
    expect(failure).toMatchObject({
      kind: "unavailable",
      message:
        "Your member role does not permit this manage_organization operation.",
    });
  });
});

describe("write tool account access", () => {
  const limited = (email: string) =>
    checkDemoAccountAccess({
      email,
      config: { email: "limited@example.test", organizationId: "org_1" },
      operation: "growth",
    });

  test("a standard tool refuses the limited account and admits others; a sandbox tool admits both", () => {
    const definitions = writeDefinitions();
    const standard = definitions.filter(
      (definition) =>
        definition.access === "write" && definition.accountAccess !== "sandbox",
    );
    expect(
      standard
        .map((definition) =>
          definition.access === "write"
            ? `${definition.name}:${definition.accountAccess}`
            : definition.name,
        )
        .toSorted(),
    ).toEqual([
      "fill_template:standard",
      "manage_organization:account-control",
      "save_filled_template:standard",
      "set_practice_jurisdictions:standard",
      "submit_feedback:standard",
    ]);
    for (const definition of definitions) {
      expect({
        name: definition.name,
        limited: isAccountAuthorizedForMcpTool(
          "limited@example.test",
          definition,
          limited,
        ),
        other: isAccountAuthorizedForMcpTool(
          "member@example.test",
          definition,
          limited,
        ),
      }).toEqual({
        name: definition.name,
        limited: !standard.includes(definition),
        other: true,
      });
    }
  });

  test("discovery and dispatch read the declared account access", async () => {
    const previousEmail = env.DEMO_ACCOUNT_EMAIL;
    env.DEMO_ACCOUNT_EMAIL = "limited@example.test";
    try {
      const context = asTestRaw<McpRequestContext>({
        enabledRegistrySlugs: undefined,
        grantedScopes: [],
        memberRole: "owner",
        userEmail: "limited@example.test",
      });
      const offered = new Set(
        listOfferedStaticMcpToolDefinitions({ context, mode: "default" }).map(
          (definition) => definition.name,
        ),
      );
      expect(offered.has("manage_organization")).toBe(false);
      expect(offered.has("set_practice_jurisdictions")).toBe(false);
      expect(offered.has("save_matter")).toBe(true);

      const result = await handleMcpToolCall({
        args: { action: "update_org_settings", prompt_caching_enabled: true },
        context,
        toolName: "manage_organization",
      });
      expect(payloadOf(result)).toEqual({
        error: {
          code: "permission_denied",
          message: "This operation is unavailable for this account.",
        },
      });
    } finally {
      env.DEMO_ACCOUNT_EMAIL = previousEmail;
    }
  });
});
