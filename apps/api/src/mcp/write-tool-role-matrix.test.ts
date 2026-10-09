import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { DOCUMENT_VERSION_UPLOAD_TRANSPORT } from "@stll/api-contract";
import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";
import type { PermissionInput } from "@stll/permissions";
import { roles } from "@stll/permissions";

import feedbackCreateEndpoint from "@/api/handlers/feedback/create";
import readAIConfigEndpoint from "@/api/handlers/organization-settings/read-ai-config";
import updateAIConfigEndpoint from "@/api/handlers/organization-settings/update-ai-config";
import {
  UPLOAD_PURPOSE_PERMISSION,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import type { AccountAccess } from "@/api/lib/api-handlers";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { isMemberRole, type MemberRole } from "@/api/lib/member-roles";
import {
  type AuthorizedMemberRole,
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { loadCapabilityEndpoint } from "@/api/mcp/capability-tools";
import { MCP_MODES, type McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { mcpMemberAuthority } from "@/api/mcp/effective-authority";
import { listOfferedStaticMcpToolDefinitions } from "@/api/mcp/gateway/static-tool-visibility";
import { CAPABILITY_FEATURE_BINDINGS } from "@/api/mcp/generated/capability-feature-bindings";
import { DEFAULT_MCP_CLI_ANNOTATIONS } from "@/api/mcp/static-cli-metadata";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";
import { handleMcpToolCall } from "@/api/mcp/tools";
import {
  isMemberAuthorizedForMcpTool,
  isMemberAuthorizedForMcpToolInput,
  type McpToolAuthorityDeclaration,
  type McpWriteToolOperationSelector,
  selectableOperations,
} from "@/api/mcp/write-tool-authority";
import { callMcpToolOverHttp } from "@/api/tests/helpers/mcp-http-tool-call";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { parseCapabilityCatalog } from "../../../../packages/cli/src/capability-catalog-load";
import {
  buildCliRouteTree,
  isCatalogTransportInvocable,
} from "../../../../packages/cli/src/generate-capability-tree";
import registrySnapshot from "../../../../packages/cli/src/generated/registry-snapshot.json" with { type: "json" };
import {
  EXIT_CODES,
  resolveMcpErrorCodeExit,
} from "../../../../packages/cli/src/mcp-constants";
import type {
  RegistryToolListing,
  RouteNode,
  ToolAnnotation,
} from "../../../../packages/cli/src/route-types";

// The role matrix for write tools. A write tool's expected outcome for a role
// is not written down here: it is read from the REST endpoints that perform
// the same operations, through the same check the REST wrapper runs
// (`hasMemberPermission` on the handler config's `permissions`). A tool is
// offered and callable exactly when the role may perform at least one of its
// operations over REST; otherwise it is withheld from discovery and refused
// with `permission_denied` on a direct call. The CLI is an MCP client of the
// default surface, so its command tree and its call outcomes are asserted
// against the same server boundary.

const MEMBER_ROLES: readonly MemberRole[] =
  Object.keys(roles).filter(isMemberRole);

// --- REST counterparts --------------------------------------------------------

/** One REST endpoint, by capability id or by a handler config outside the catalog. */
type RestEndpointRef =
  | { type: "capability"; id: string }
  | {
      type: "handler";
      name: string;
      config: { permissions?: PermissionInput; accountAccess?: AccountAccess };
    };

/**
 * One operation a write tool's input can select, and the REST endpoints a
 * client calls to perform the same operation (all of them are needed).
 */
type RestOperation = { endpoints: readonly RestEndpointRef[]; reason: string };

const capability = (id: string): RestEndpointRef => ({
  type: "capability",
  id,
});

/**
 * Operations the capability catalog's `mcp` disposition does not attribute to
 * the tool. The catalog maps each REST endpoint to at most one curated tool, so
 * an endpoint another tool claims, or one that stays a generic capability, is
 * named here with the reason it is the same operation.
 */
const ADDITIONAL_REST_OPERATIONS: Readonly<
  Record<string, readonly RestOperation[]>
> = {
  configure_template_fields: [
    {
      endpoints: [capability("templates.update")],
      reason:
        "Field configuration is a template update in the template editor.",
    },
  ],
  create_template: [
    {
      endpoints: [capability("templates.update")],
      reason: "template_id selects updating an existing template.",
    },
  ],
  delete_task: [
    {
      endpoints: [capability("entities.delete")],
      reason: "A task is an entity; the UI deletes it through entity deletion.",
    },
  ],
  open_document_version_upload: [
    {
      endpoints: [capability("entities.versions.upload")],
      reason: "Opens the upload that lands as a new document version.",
    },
  ],
  open_file_comparison: [
    {
      endpoints: [capability("documents.compare")],
      reason: "Stages files whose only use is a document comparison.",
    },
  ],
  prepare_file_comparison: [
    {
      endpoints: [capability("documents.compare")],
      reason: "Stages files whose only use is a document comparison.",
    },
  ],
  prepare_file_comparison_from_links: [
    {
      endpoints: [capability("documents.compare")],
      reason: "Stages files whose only use is a document comparison.",
    },
  ],
  save_filled_template: [
    {
      endpoints: [
        capability("templates.fill"),
        capability("entities.versions.upload"),
      ],
      reason:
        "Saving a fill as a new version is a fill followed by a version upload.",
    },
  ],
  submit_feedback: [
    {
      endpoints: [
        {
          type: "handler",
          name: "feedback.create",
          config: feedbackCreateEndpoint.config,
        },
      ],
      reason: "The web app files the same report through its feedback route.",
    },
  ],
  upload_document_version: [
    {
      endpoints: [capability("entities.versions.upload")],
      reason: "Lands the staged file as a new document version.",
    },
  ],
};

/** Write tools with no REST or UI counterpart, each with the reason. */
const NO_REST_COUNTERPART = {
  write_capability:
    "Dispatches a catalog capability chosen at call time; that capability's own REST permissions are checked before dispatch.",
} as const satisfies Readonly<Record<string, string>>;

const isNoRestCounterpart = (
  name: string,
): name is keyof typeof NO_REST_COUNTERPART =>
  Object.hasOwn(NO_REST_COUNTERPART, name);

const catalogEntrySchema = v.object({
  id: v.string(),
  mcp: v.variant("type", [
    v.object({ type: v.literal("tool"), name: v.string() }),
    v.object({ type: v.literal("covered"), by: v.string() }),
    v.object({ type: v.literal("capability"), reason: v.string() }),
  ]),
  permissions: v.optional(v.unknown()),
});
const rawCatalog = v.parse(
  v.array(catalogEntrySchema),
  readCapabilityCatalog(),
);

/** Catalog endpoints the catalog attributes to a curated tool, by tool name. */
const curatedToolOf = (
  disposition: v.InferOutput<typeof catalogEntrySchema>["mcp"],
): string | null => {
  switch (disposition.type) {
    case "tool":
      return disposition.name;
    case "covered":
      return disposition.by;
    case "capability":
      return null;
    default:
      disposition satisfies never;
      return null;
  }
};

const catalogOperationsByTool = new Map<string, RestOperation[]>();
for (const entry of rawCatalog) {
  const tool = curatedToolOf(entry.mcp);
  if (tool === null) {
    continue;
  }
  const operations = catalogOperationsByTool.get(tool) ?? [];
  operations.push({
    endpoints: [capability(entry.id)],
    reason: `catalog disposition of ${entry.id}`,
  });
  catalogOperationsByTool.set(tool, operations);
}

/**
 * The REST grant and account access an endpoint declares, read from its live
 * handler config.
 */
const restDeclarationOf = async (
  endpoint: RestEndpointRef,
): Promise<{ permissions: PermissionInput; accountAccess: AccountAccess }> => {
  const config =
    endpoint.type === "handler"
      ? endpoint.config
      : (await loadCapabilityEndpoint(endpoint.id))?.config;
  const name = endpoint.type === "handler" ? endpoint.name : endpoint.id;
  if (config?.permissions === undefined || config.accountAccess === undefined) {
    // A write endpoint always declares both; one without is not a
    // counterpart this matrix can derive from.
    throw new Error(`REST endpoint ${name} declares no permissions`);
  }
  return {
    permissions: config.permissions,
    accountAccess: config.accountAccess,
  };
};

// --- MCP write tools ----------------------------------------------------------

type WriteTool = McpToolDefinition & McpToolAuthorityDeclaration;

/** Every static write tool, once per name, with the modes it is served on. */
const writeTools = (() => {
  const byName = new Map<string, { definition: WriteTool; modes: McpMode[] }>();
  for (const mode of MCP_MODES) {
    for (const definition of listStaticMcpToolDefinitions(mode)) {
      if (definition.access !== "write") {
        continue;
      }
      const current = byName.get(definition.name);
      byName.set(definition.name, {
        definition,
        modes: [...(current?.modes ?? []), mode],
      });
    }
  }
  return [...byName.values()].toSorted((left, right) =>
    left.definition.name < right.definition.name ? -1 : 1,
  );
})();

type ResolvedOperation = {
  endpoints: string[];
  permissions: PermissionInput[];
  accountAccess: AccountAccess[];
};

/** The REST operations behind each write tool, with their declared grants. */
const restOperationsByTool = new Map<string, ResolvedOperation[]>();
for (const { definition } of writeTools) {
  const operations = [
    ...(catalogOperationsByTool.get(definition.name) ?? []),
    ...(ADDITIONAL_REST_OPERATIONS[definition.name] ?? []),
  ];
  const resolved: ResolvedOperation[] = [];
  for (const operation of operations) {
    const permissions: PermissionInput[] = [];
    const accountAccess: AccountAccess[] = [];
    for (const endpoint of operation.endpoints) {
      // db-await-in-loop: no database; each dispatch thunk loads one module.
      const declaration = await restDeclarationOf(endpoint);
      permissions.push(declaration.permissions);
      accountAccess.push(declaration.accountAccess);
    }
    resolved.push({
      endpoints: operation.endpoints.map((endpoint) =>
        endpoint.type === "capability" ? endpoint.id : endpoint.name,
      ),
      permissions,
      accountAccess,
    });
  }
  restOperationsByTool.set(definition.name, resolved);
}

/** REST: may this role perform the operation (every endpoint it needs)? */
const restAllows = (role: MemberRole, operation: ResolvedOperation): boolean =>
  operation.permissions.every((permissions) =>
    hasMemberPermission(sessionMemberRole(role), permissions),
  );

/**
 * The expectation for a tool and role, derived from REST alone. `null` for a
 * tool with no REST counterpart (its row asserts the declared fallback).
 */
const restExpectation = (tool: string, role: MemberRole): boolean | null => {
  if (isNoRestCounterpart(tool)) {
    return null;
  }
  const operations = restOperationsByTool.get(tool) ?? [];
  return operations.some((operation) => restAllows(role, operation));
};

/** Union of several permission sets, as sorted `resource:action` pairs. */
type PermissionSet = Readonly<Record<string, readonly string[] | undefined>>;

const permissionInputSchema = v.record(v.string(), v.array(v.string()));

const permissionPairs = (sets: readonly PermissionSet[]): string[] => {
  const pairs = new Set<string>();
  for (const set of sets) {
    for (const [resource, actions] of Object.entries(set)) {
      for (const action of actions ?? []) {
        pairs.add(`${resource}:${action}`);
      }
    }
  }
  return [...pairs].toSorted();
};

/** The grant sets a tool declares, one per operation it can select. */
const declaredGrantSets = (definition: WriteTool): string[][] => {
  if (definition.access !== "write") {
    return [];
  }
  const { permissions } = definition;
  switch (permissions.type) {
    case "all":
      return [permissionPairs([permissions.permissions])];
    case "input":
      return selectableOperations(permissions.select).map((operation) =>
        permissionPairs([operation.permissions]),
      );
    case "any":
      return permissions.alternatives.map((alternative) =>
        permissionPairs([alternative]),
      );
    case "delegated":
      return [];
    default:
      permissions satisfies never;
      return [];
  }
};

// --- Operations selected by input -------------------------------------------

/**
 * For each tool whose input selects its operation, the REST endpoints that
 * perform each operation. Every REST counterpart of the tool appears under
 * exactly one operation, and each endpoint must declare that operation's
 * grant.
 */
const REST_ENDPOINTS_BY_OPERATION: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  create_template: {
    create: ["templates.create"],
    update: ["templates.update"],
  },
  delete_document: {
    delete: ["entities.delete"],
    delete_version: ["entities.versions.delete"],
  },
  manage_organization: {
    add_member: ["matters.members.add"],
    remove_member: ["matters.members.remove"],
    update_org_settings: ["organization-settings.update"],
  },
  save_clause: { create: ["clauses.create"], update: ["clauses.update"] },
  save_contact: {
    create: ["contacts.create", "contacts.import"],
    update: ["contacts.update"],
  },
  save_matter: {
    create: ["matters.create"],
    update: ["matters.update", "matters.archive", "matters.unarchive"],
  },
  save_playbook: {
    create: ["playbooks.create"],
    update: ["playbooks.update"],
  },
  save_task: {
    create: ["tasks.create"],
    update: [
      "tasks.update",
      "tasks.assignees.add",
      "tasks.assignees.move",
      "tasks.assignees.remove",
      "tasks.entity-links.create",
      "tasks.entity-links.delete",
    ],
  },
  save_time_entry: {
    create: ["time-entries.create"],
    update: ["time-entries.update"],
  },
};

/** Each single-endpoint REST operation behind a write tool, by endpoint id. */
const restEndpointGrant = (
  tool: string,
  endpoint: string,
): PermissionInput | null =>
  (restOperationsByTool.get(tool) ?? []).find(
    (operation) =>
      operation.endpoints.length === 1 && operation.endpoints[0] === endpoint,
  )?.permissions[0] ?? null;

const inputSelectorOf = (
  definition: WriteTool,
): McpWriteToolOperationSelector | null =>
  definition.access === "write" && definition.permissions.type === "input"
    ? definition.permissions.select
    : null;

/** An input that selects `operation`, built from the selector itself. */
const inputSelecting = (
  select: McpWriteToolOperationSelector,
  operation: string,
): Record<string, unknown> => {
  switch (select.by) {
    case "presence":
      return select.present.operation === operation
        ? { [select.property]: "00000000-0000-4000-8000-000000000001" }
        : {};
    case "value": {
      const value = Object.entries(select.values).find(
        ([, candidate]) => candidate.operation === operation,
      )?.[0];
      return value === undefined ? {} : { [select.property]: value };
    }
    default:
      select satisfies never;
      return {};
  }
};

/**
 * Where a tool's per-operation declaration and REST disagree: an operation
 * REST does not name, a REST endpoint under no operation, or an endpoint
 * whose grant is not the operation's declared grant.
 */
const inputOperationMismatches = (definition: WriteTool): string[] => {
  const select = inputSelectorOf(definition);
  if (select === null) {
    return [];
  }
  const tool = definition.name;
  const restByOperation = REST_ENDPOINTS_BY_OPERATION[tool] ?? {};
  const declared = selectableOperations(select);
  const mismatches: string[] = [];
  for (const operation of declared) {
    const endpoints = restByOperation[operation.operation] ?? [];
    if (endpoints.length === 0) {
      mismatches.push(`${tool} ${operation.operation} names no REST endpoint`);
    }
    const declaredPairs = permissionPairs([operation.permissions]).join(",");
    for (const endpoint of endpoints) {
      const grant = restEndpointGrant(tool, endpoint);
      const restPairs =
        grant === null
          ? "<not a REST counterpart>"
          : permissionPairs([grant]).join(",");
      if (restPairs !== declaredPairs) {
        mismatches.push(
          `${tool} ${operation.operation} declares ${declaredPairs}; REST ${endpoint} needs ${restPairs}`,
        );
      }
    }
  }
  const declaredNames = new Set(
    declared.map((operation) => operation.operation),
  );
  for (const name of Object.keys(restByOperation)) {
    if (!declaredNames.has(name)) {
      mismatches.push(
        `${tool} maps REST endpoints to undeclared operation ${name}`,
      );
    }
  }
  const mapped = new Set(Object.values(restByOperation).flat());
  for (const operation of restOperationsByTool.get(tool) ?? []) {
    for (const endpoint of operation.endpoints) {
      if (!mapped.has(endpoint)) {
        mismatches.push(`${tool}: REST ${endpoint} is under no operation`);
      }
    }
  }
  return mismatches;
};

/** REST: may this authority perform every endpoint of the operation? */
const restAllowsOperation = (
  authority: AuthorizedMemberRole,
  tool: string,
  operation: string,
): boolean =>
  (REST_ENDPOINTS_BY_OPERATION[tool]?.[operation] ?? []).every((endpoint) => {
    const grant = restEndpointGrant(tool, endpoint);
    return grant !== null && hasMemberPermission(authority, grant);
  });

/**
 * The call-time decision for an input selecting `operation`, against the
 * REST decision for the same operation; `null` when they agree.
 */
const operationDecisionMismatch = ({
  authority,
  definition,
  operation,
}: {
  authority: AuthorizedMemberRole;
  definition: WriteTool;
  operation: string;
}): string | null => {
  const select = inputSelectorOf(definition);
  if (select === null) {
    return `${definition.name} does not select its operation by input`;
  }
  const declared = isMemberAuthorizedForMcpToolInput(
    authority,
    definition,
    inputSelecting(select, operation),
  );
  const rest = restAllowsOperation(authority, definition.name, operation);
  return declared === rest
    ? null
    : `${definition.name} ${operation}: declared ${declared}, REST ${rest}`;
};

type OperationRow = { tool: string; operation: string; role: MemberRole };

const OPERATION_MATRIX: readonly OperationRow[] = writeTools.flatMap(
  ({ definition }) => {
    const select = inputSelectorOf(definition);
    return select === null
      ? []
      : selectableOperations(select).flatMap(({ operation }) =>
          MEMBER_ROLES.map((role) => ({
            tool: definition.name,
            operation,
            role,
          })),
        );
  },
);

// --- Account access -----------------------------------------------------------

/**
 * The account access a write tool must declare: the most restrictive of the
 * REST operations it performs (`account-control`, then `standard`, else
 * `sandbox`). A tool without a REST counterpart dispatches to a target that
 * applies its own.
 */
const expectedAccountAccess = (tool: string): AccountAccess => {
  const declared = (restOperationsByTool.get(tool) ?? []).flatMap(
    (operation) => operation.accountAccess,
  );
  if (declared.includes("account-control")) {
    return "account-control";
  }
  return declared.includes("standard") ? "standard" : "sandbox";
};

const accountAccessMismatches = (definitions: readonly WriteTool[]): string[] =>
  definitions.flatMap((definition) => {
    if (definition.access !== "write") {
      return [];
    }
    const expected = expectedAccountAccess(definition.name);
    return definition.accountAccess === expected
      ? []
      : [
          `${definition.name} declares ${definition.accountAccess}; REST counterparts need ${expected}`,
        ];
  });

// --- Surfaces -----------------------------------------------------------------

const mcpContextFor = (role: MemberRole): McpRequestContext =>
  asTestRaw<McpRequestContext>({
    enabledRegistrySlugs: undefined,
    grantedScopes: [],
    accessibleWorkspaceIds: ["workspace_1"],
    memberRole: role,
    userId: "user_1",
    organizationId: "org_1",
    featureAccessSnapshot: createFeatureAccessSnapshot({
      userId: "user_1",
      organizationId: "org_1",
      decisions: new Map(
        Object.entries(FEATURE_REGISTRY).map(([featureId, definition]) => [
          featureId,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            featureId,
            userId: "user_1",
            organizationId: "org_1",
            membership: true,
            user: { email: "member@example.test", emailVerified: true },
            grants: Object.fromEntries(
              Object.keys(FEATURE_REGISTRY).map((id) => [
                id,
                [{ type: "organization" as const, organizationId: "org_1" }],
              ]),
            ),
            enrolments:
              definition.enrolment === "self-serve"
                ? [{ featureId, userId: "user_1", organizationId: "org_1" }]
                : [],
          }),
        ]),
      ),
    }),
  });

const unenrolledMcpContextFor = (role: MemberRole): McpRequestContext => {
  const context = mcpContextFor(role);
  return {
    ...context,
    featureAccessSnapshot: createFeatureAccessSnapshot({
      userId: context.userId,
      organizationId: context.organizationId,
      decisions: new Map(
        Object.keys(FEATURE_REGISTRY).map(
          (featureId) => [featureId, { status: "hidden" }] as const,
        ),
      ),
    }),
  };
};

const offeredOn = (role: MemberRole, mode: McpMode): ReadonlySet<string> =>
  new Set(
    listOfferedStaticMcpToolDefinitions({
      context: mcpContextFor(role),
      mode,
    }).map((definition) => definition.name),
  );

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(
  writeTools.map(({ definition }) => definition.name),
);

/** An argument no tool declares: dispatch stops at input validation, after the gate. */
const GATE_PROBE_ARGUMENT = "role_matrix_gate_probe";

type CallOutcome = "permission_denied" | "past_permission_gate";

const errorCodeOf = (result: CallToolResult): string | null => {
  const item = result.content.at(0);
  const payload: unknown = item?.type === "text" ? JSON.parse(item.text) : null;
  const parsed = v.safeParse(
    v.object({ error: v.object({ code: v.string() }) }),
    payload,
  );
  return parsed.success ? parsed.output.error.code : null;
};

/**
 * Call a tool by name over HTTP, the transport the CLI uses, and read where
 * dispatch stopped. The direct dispatch entry point must answer the same.
 */
const callOutcome = async ({
  args,
  mode,
  role,
  tool,
}: {
  args: Record<string, unknown>;
  mode: McpMode;
  role: MemberRole;
  tool: string;
}): Promise<{ outcome: CallOutcome; code: string | null }> => {
  const call = { args, context: mcpContextFor(role), mode, toolName: tool };
  const code = errorCodeOf(await callMcpToolOverHttp(call));
  expect({ tool, role, mode, code }).toEqual({
    tool,
    role,
    mode,
    code: errorCodeOf(await handleMcpToolCall(call)),
  });
  return {
    code,
    outcome:
      code === "permission_denied"
        ? "permission_denied"
        : "past_permission_gate",
  };
};

/**
 * The CLI command tree for a role, built by the CLI's own builder from the
 * listings the server returns that role (`tools/list` on the default
 * surface). Role-withheld tools are not attested as feature or scope
 * omissions, so the CLI does not restore them from its baked snapshot.
 */
const bakedListings: readonly RegistryToolListing[] = registrySnapshot.map(
  (entry) => ({
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
  }),
);
const cliCatalogEntries = parseCapabilityCatalog(readCapabilityCatalog());
if (cliCatalogEntries === null) {
  throw new TypeError("Invalid capability catalog");
}
const catalogEntries = cliCatalogEntries;

/**
 * The API-owned CLI metadata the CLI's tool annotations are generated from.
 * The generated module is a build output, so a plain typecheck of this
 * package cannot rely on it.
 */
const cliAnnotations: Readonly<Record<string, ToolAnnotation>> =
  DEFAULT_MCP_CLI_ANNOTATIONS;

const cliTreeFor = (offered: ReadonlySet<string> | null): RouteNode =>
  buildCliRouteTree({
    annotations: cliAnnotations,
    entries: catalogEntries,
    listings:
      offered === null
        ? bakedListings
        : bakedListings.filter((listing) => offered.has(listing.name)),
  }).tree;

type CliLeaf = { commandPath: readonly string[]; toolName: string };

const curatedLeaves = (node: RouteNode): CliLeaf[] => {
  switch (node.kind) {
    case "leaf":
      return [
        { commandPath: node.spec.commandPath, toolName: node.spec.toolName },
      ];
    case "capability-leaf":
      return [];
    case "route":
      return Object.values(node.children).flatMap(curatedLeaves);
    default:
      node satisfies never;
      return [];
  }
};

const capabilityLeafIds = (node: RouteNode): string[] => {
  switch (node.kind) {
    case "leaf":
      return [];
    case "capability-leaf":
      return [node.spec.capabilityId];
    case "route":
      return Object.values(node.children).flatMap(capabilityLeafIds);
    default:
      node satisfies never;
      return [];
  }
};

const cliWriteToolsFor = (role: MemberRole): string[] =>
  [
    ...new Set(
      curatedLeaves(cliTreeFor(offeredOn(role, "default")))
        .map((leaf) => leaf.toolName)
        .filter((name) => WRITE_TOOL_NAMES.has(name)),
    ),
  ].toSorted();

// --- Matrix -------------------------------------------------------------------

type MatrixRow = { tool: string; role: MemberRole; modes: McpMode[] };

const MATRIX: readonly MatrixRow[] = writeTools.flatMap(
  ({ definition, modes }) =>
    MEMBER_ROLES.map((role) => ({ tool: definition.name, role, modes })),
);

describe("write tool role matrix", () => {
  test("every write tool has a REST counterpart or a stated reason it has none", () => {
    const unaccounted = writeTools
      .map(({ definition }) => definition.name)
      .filter(
        (name) =>
          !isNoRestCounterpart(name) &&
          (restOperationsByTool.get(name) ?? []).length === 0,
      );
    expect(unaccounted).toEqual([]);
    // No stale rows: every listed tool is still a write tool, and one listed
    // without a counterpart really has none in the catalog.
    for (const name of [
      ...Object.keys(ADDITIONAL_REST_OPERATIONS),
      ...Object.keys(NO_REST_COUNTERPART),
    ]) {
      expect({ name, write: WRITE_TOOL_NAMES.has(name) }).toEqual({
        name,
        write: true,
      });
    }
    for (const name of Object.keys(NO_REST_COUNTERPART)) {
      expect({ name, catalog: catalogOperationsByTool.get(name) }).toEqual({
        name,
        catalog: undefined,
      });
    }
  });

  test("the matrix covers every write tool for every role", () => {
    expect(MEMBER_ROLES.length).toBe(5);
    expect(MATRIX.length).toBe(writeTools.length * MEMBER_ROLES.length);
  });

  test("each declared grant is the grant of one REST operation, and each REST operation is declared", () => {
    const mismatches = writeTools.flatMap(({ definition }) => {
      if (isNoRestCounterpart(definition.name)) {
        return [];
      }
      const declared = declaredGrantSets(definition).map((pairs) =>
        pairs.join(","),
      );
      const rest = (restOperationsByTool.get(definition.name) ?? []).map(
        (operation) => ({
          endpoints: operation.endpoints.join("+"),
          pairs: permissionPairs(operation.permissions).join(","),
        }),
      );
      const restPairs = new Set(rest.map((operation) => operation.pairs));
      return [
        ...declared
          .filter((pairs) => !restPairs.has(pairs))
          .map(
            (pairs) =>
              `${definition.name} declares ${pairs} with no REST operation`,
          ),
        ...rest
          .filter((operation) => !declared.includes(operation.pairs))
          .map(
            (operation) =>
              `${definition.name}: REST ${operation.endpoints} needs ${operation.pairs}, not declared`,
          ),
      ];
    });
    expect(mismatches).toEqual([]);
  });

  test.each(MATRIX)("$tool as $role", async ({ tool, role, modes }) => {
    const definition = writeTools.find(
      (candidate) => candidate.definition.name === tool,
    )?.definition;
    if (definition === undefined) {
      throw new Error(`Unknown write tool ${tool}`);
    }
    const expected =
      restExpectation(tool, role) ??
      // No REST counterpart: the declaration is delegated, so the tool is
      // offered and its target is checked at dispatch.
      isMemberAuthorizedForMcpTool(sessionMemberRole(role), definition);

    for (const mode of modes) {
      expect({
        tool,
        role,
        mode,
        offered: offeredOn(role, mode).has(tool),
      }).toEqual({ tool, role, mode, offered: expected });
      const { outcome } = await callOutcome({
        args: { [GATE_PROBE_ARGUMENT]: true },
        mode,
        role,
        tool,
      });
      expect({ tool, role, mode, outcome }).toEqual({
        tool,
        role,
        mode,
        outcome: expected ? "past_permission_gate" : "permission_denied",
      });
    }
  });
});

describe("write tool operation matrix", () => {
  test("every tool whose input selects its operation maps each operation to REST endpoints with its exact grant", () => {
    expect(Object.keys(REST_ENDPOINTS_BY_OPERATION).toSorted()).toEqual(
      writeTools
        .filter(({ definition }) => inputSelectorOf(definition) !== null)
        .map(({ definition }) => definition.name),
    );
    expect(
      writeTools.flatMap(({ definition }) =>
        inputOperationMismatches(definition),
      ),
    ).toEqual([]);
  });

  test("the operation matrix covers every operation for every role", () => {
    const operations = writeTools.flatMap(({ definition }) => {
      const select = inputSelectorOf(definition);
      return select === null ? [] : selectableOperations(select);
    });
    expect(operations.length).toBeGreaterThan(0);
    expect(OPERATION_MATRIX.length).toBe(
      operations.length * MEMBER_ROLES.length,
    );
  });

  test.each(OPERATION_MATRIX)(
    "$tool $operation as $role",
    ({ tool, operation, role }) => {
      const definition = writeTools.find(
        (candidate) => candidate.definition.name === tool,
      )?.definition;
      if (definition === undefined) {
        throw new Error(`Unknown write tool ${tool}`);
      }
      expect(
        operationDecisionMismatch({
          authority: sessionMemberRole(role),
          definition,
          operation,
        }),
      ).toBeNull();
    },
  );
});

describe("write tool account access", () => {
  test("each write tool declares the account access of its REST counterparts", () => {
    expect(
      accountAccessMismatches(writeTools.map(({ definition }) => definition)),
    ).toEqual([]);
  });
});

describe("write tool operation matrix self-test", () => {
  const deleteDocument = writeTools.find(
    ({ definition }) => definition.name === "delete_document",
  )?.definition;
  if (
    deleteDocument?.access !== "write" ||
    deleteDocument.permissions.type !== "input" ||
    deleteDocument.permissions.select.by !== "presence"
  ) {
    throw new Error("delete_document must select its operation by version_id");
  }
  const { select } = deleteDocument.permissions;
  // Deleting the whole document declared with the grant of deleting a version.
  const weakened: WriteTool = {
    ...deleteDocument,
    permissions: {
      type: "input",
      select: {
        ...select,
        absent: { ...select.absent, permissions: { entity: ["update"] } },
      },
    },
  };

  test("a declaration weaker than REST for delete fails the structural check", () => {
    expect(inputOperationMismatches(weakened)).toContain(
      "delete_document delete declares entity:update; REST entities.delete needs entity:delete",
    );
  });

  test("a declaration weaker than REST for delete fails the decision check", () => {
    // Roles hold entity update and delete together, so the divergence shows
    // for a credential attenuated to entity:update.
    const updateOnly = mcpMemberAuthority({
      memberRole: "owner",
      credentialPermissions: { entity: ["update"] },
    });
    expect(
      operationDecisionMismatch({
        authority: updateOnly,
        definition: weakened,
        operation: "delete",
      }),
    ).toBe("delete_document delete: declared true, REST false");
    expect(
      operationDecisionMismatch({
        authority: updateOnly,
        definition: deleteDocument,
        operation: "delete",
      }),
    ).toBeNull();
  });

  test("an account access weaker than REST fails the account check", () => {
    const definition = writeTools.find(
      (candidate) => candidate.definition.name === "set_practice_jurisdictions",
    )?.definition;
    if (definition?.access !== "write") {
      throw new Error("set_practice_jurisdictions must be a write tool");
    }
    expect(
      accountAccessMismatches([{ ...definition, accountAccess: "sandbox" }]),
    ).toEqual([
      "set_practice_jurisdictions declares sandbox; REST counterparts need standard",
    ]);
  });
});

// --- CLI parity -----------------------------------------------------------------

/** Write tools the CLI's tool annotations exclude from its command tree. */
const isCliExcluded = (name: string): boolean =>
  cliAnnotations[name]?.excluded === true;

/**
 * How the CLI performs the operation of a write tool it excludes (an MCP App
 * launcher or a host-file adapter), and what that path is granted for a role.
 */
const CLI_REPLACEMENTS: Readonly<
  Record<string, { via: string; allows: (role: MemberRole) => boolean }>
> = (() => {
  // `stella upload --entity-id` reserves and finalizes through the uploads
  // capabilities with the version purpose: the route's floor plus the
  // purpose's own grant.
  const versionUpload = {
    via: `upload (${DOCUMENT_VERSION_UPLOAD_TRANSPORT.purpose})`,
    allows: (role: MemberRole) =>
      hasMemberPermission(sessionMemberRole(role), uploadRoutePermission) &&
      hasMemberPermission(
        sessionMemberRole(role),
        UPLOAD_PURPOSE_PERMISSION[DOCUMENT_VERSION_UPLOAD_TRANSPORT.purpose],
      ),
  };
  return {
    open_document_version_upload: versionUpload,
    open_file_comparison: {
      via: "prepare_file_comparison",
      allows: (role: MemberRole) =>
        offeredOn(role, "default").has("prepare_file_comparison"),
    },
    upload_document_version: versionUpload,
  };
})();

describe("CLI and MCP write tool parity", () => {
  test.each(MEMBER_ROLES)(
    "the CLI offers %s exactly the write commands MCP offers",
    (role) => {
      const mcpWrite = [...offeredOn(role, "default")]
        .filter((name) => WRITE_TOOL_NAMES.has(name) && !isCliExcluded(name))
        .toSorted();
      expect(cliWriteToolsFor(role)).toEqual(mcpWrite);
    },
  );

  test("every default-surface write tool is a CLI command or has a CLI replacement", () => {
    const cliTools = new Set(
      curatedLeaves(cliTreeFor(null)).map((leaf) => leaf.toolName),
    );
    const defaultWriteTools = writeTools
      .filter(({ modes }) => modes.includes("default"))
      .map(({ definition }) => definition.name);
    expect(defaultWriteTools.filter((name) => !cliTools.has(name))).toEqual(
      defaultWriteTools.filter(isCliExcluded),
    );
    expect(defaultWriteTools.filter(isCliExcluded).toSorted()).toEqual(
      Object.keys(CLI_REPLACEMENTS).toSorted(),
    );
  });

  test.each(MEMBER_ROLES)(
    "the CLI path replacing an excluded write tool grants %s what MCP grants",
    (role) => {
      const rows = Object.entries(CLI_REPLACEMENTS).map(([tool, path]) => ({
        tool,
        via: path.via,
        cli: path.allows(role),
        mcp: offeredOn(role, "default").has(tool),
      }));
      expect(rows.filter((row) => row.cli !== row.mcp)).toEqual([]);
    },
  );

  test.each(MEMBER_ROLES)(
    "a CLI call from the offline tree as %s gets the MCP outcome and exit class",
    async (role) => {
      // The baked tree is role-agnostic (used before the first registry
      // refresh), so the server's call-time gate decides; the CLI maps a
      // refusal to its permission-denied exit code.
      const results = [];
      for (const leaf of curatedLeaves(cliTreeFor(null))) {
        if (!WRITE_TOOL_NAMES.has(leaf.toolName)) {
          continue;
        }
        // db-await-in-loop: no database; dispatch stops at the gate or input check.
        const { code, outcome } = await callOutcome({
          args: { [GATE_PROBE_ARGUMENT]: true },
          mode: "default",
          role,
          tool: leaf.toolName,
        });
        results.push({
          command: leaf.commandPath.join(" "),
          exit: code === null ? null : (resolveMcpErrorCodeExit(code) ?? null),
          outcome,
          offered: offeredOn(role, "default").has(leaf.toolName),
        });
      }
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.outcome === "past_permission_gate").toBe(result.offered);
        if (!result.offered) {
          expect(result.exit).toBe(EXIT_CODES.permissionDenied);
        }
      }
    },
  );

  test("every REST endpoint behind a write tool is also a CLI capability command with the same grant", async () => {
    const capabilityIds = new Set(capabilityLeafIds(cliTreeFor(null)));
    const catalogPermissions = new Map(
      rawCatalog.map((entry) => [entry.id, entry.permissions]),
    );
    // A file-transport capability has no JSON command; the CLI uploads it
    // through its own upload route instead.
    const jsonInvocable = new Set(
      catalogEntries
        .filter((entry) => isCatalogTransportInvocable(entry.transport))
        .map((entry) => entry.id),
    );
    const rows: { id: string; cli: boolean; samePermissions: boolean }[] = [];
    for (const operations of restOperationsByTool.values()) {
      for (const operation of operations) {
        for (const [index, id] of operation.endpoints.entries()) {
          if (!catalogPermissions.has(id)) {
            continue;
          }
          rows.push({
            id,
            cli: capabilityIds.has(id) || !jsonInvocable.has(id),
            // The catalog (which the CLI and write_capability read) carries
            // the same grant as the live REST handler config.
            samePermissions:
              JSON.stringify(
                permissionPairs([
                  v.parse(permissionInputSchema, catalogPermissions.get(id)),
                ]),
              ) ===
              JSON.stringify(
                permissionPairs(operation.permissions.slice(index, index + 1)),
              ),
          });
        }
      }
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => !row.cli || !row.samePermissions)).toEqual([]);
  });
});

describe("static feature tool enrolment boundary", () => {
  const gatedTools = MCP_MODES.flatMap((mode) =>
    listStaticMcpToolDefinitions(mode)
      .filter((definition) => definition.featureId !== undefined)
      .map((definition) => ({ mode, definition })),
  );

  test("every declared feature tool is offered only to an enrolled authorized member", async () => {
    expect(gatedTools.length).toBeGreaterThan(0);
    for (const { mode, definition } of gatedTools) {
      for (const enrolled of [true, false]) {
        const context = mcpContextFor("owner");
        const principal = enrolled ? context : unenrolledMcpContextFor("owner");
        const offered = listOfferedStaticMcpToolDefinitions({
          context: principal,
          mode,
        }).some(({ name }) => name === definition.name);
        expect({ tool: definition.name, mode, enrolled, offered }).toEqual({
          tool: definition.name,
          mode,
          enrolled,
          offered: enrolled,
        });
        const call = {
          args: { [GATE_PROBE_ARGUMENT]: true },
          context: principal,
          mode,
          toolName: definition.name,
        };
        const expected = enrolled ? "validation_error" : "unknown_tool";
        expect(errorCodeOf(await handleMcpToolCall(call))).toBe(expected);
        expect(errorCodeOf(await callMcpToolOverHttp(call))).toBe(expected);
      }
    }
  });

  test("every generated feature capability follows its declared admission requirement", async () => {
    expect(CAPABILITY_FEATURE_BINDINGS.size).toBeGreaterThan(0);
    for (const [capabilityId, featureId] of CAPABILITY_FEATURE_BINDINGS) {
      const entry = catalogEntries.find(({ id }) => id === capabilityId);
      if (entry === undefined) {
        panic(`Feature-bound capability ${capabilityId} has no catalog entry`);
      }
      expect(entry.featureId).toBe(featureId);
      for (const enrolled of [true, false]) {
        const context = enrolled
          ? mcpContextFor("owner")
          : unenrolledMcpContextFor("owner");
        expect(context.featureAccessSnapshot?.decisions.has(featureId)).toBe(
          true,
        );
        const call = {
          args: { capability: capabilityId },
          context,
          mode: "default" as const,
          toolName: "describe_capability",
        };
        const expected =
          enrolled || entry.featureAccess === "conditional"
            ? null
            : "not_found";
        expect({
          capability: capabilityId,
          enrolled,
          code: errorCodeOf(await handleMcpToolCall(call)),
        }).toEqual({ capability: capabilityId, enrolled, code: expected });
        expect(errorCodeOf(await callMcpToolOverHttp(call))).toBe(expected);
      }
    }
  });

  test("every role-withheld feature write tool denies the role before either enrolment state", async () => {
    const withheld = gatedTools.filter(
      ({ definition }) => definition.access === "write",
    );
    expect(withheld.length).toBeGreaterThan(0);
    for (const { mode, definition } of withheld) {
      for (const role of MEMBER_ROLES) {
        if (isMemberAuthorizedForMcpTool(sessionMemberRole(role), definition)) {
          continue;
        }
        for (const enrolled of [true, false]) {
          const context = mcpContextFor(role);
          const principal = enrolled ? context : unenrolledMcpContextFor(role);
          const call = {
            args: { [GATE_PROBE_ARGUMENT]: true },
            context: principal,
            mode,
            toolName: definition.name,
          };
          expect(errorCodeOf(await handleMcpToolCall(call))).toBe(
            "permission_denied",
          );
          expect(errorCodeOf(await callMcpToolOverHttp(call))).toBe(
            "permission_denied",
          );
        }
      }
    }
  });
});

test("decision-provider settings stay outside MCP and CLI discovery during beta", () => {
  for (const endpoint of [readAIConfigEndpoint, updateAIConfigEndpoint]) {
    expect(endpoint.config.mcp).toEqual({
      type: "internal",
      reason: "provider_secret",
    });
  }
  expect(
    catalogEntries.filter(({ id }) =>
      /^organization-settings\.(?:read|update)-ai-config$/u.test(id),
    ),
  ).toEqual([]);
  for (const listing of registrySnapshot) {
    expect(JSON.stringify(listing.inputSchema)).not.toContain('"gpt-6-luna"');
    expect(listing.name).not.toMatch(/(?:read|update)_ai_config/u);
  }
  for (const definition of listStaticMcpToolDefinitions()) {
    expect(definition.name).not.toMatch(/(?:read|update)_ai_config/u);
  }
});
