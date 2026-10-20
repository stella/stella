import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { resourcesAreVisible } from "@/api/lib/entities/resource-access";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { isRecord } from "@/api/lib/type-guards";
import {
  AGENT_ACCESS_KIND,
  type AgentAccessTarget,
  type AgentCallRefusal,
  describeAgentAccess,
} from "@/api/mcp/agent-access";
import {
  loadCapabilityCatalog,
  loadCapabilityEndpoint,
} from "@/api/mcp/capability-tools";
import {
  MCP_ALL_RESOURCE_SCOPES,
  MCP_MODES,
  type McpMode,
} from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";
import { callMcpToolOverHttp } from "@/api/tests/helpers/mcp-http-tool-call";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

// Every agent-access refusal, driven over the HTTP transport the CLI and every
// remote client use. The targets are read from the live registries (each mode's
// static tools and the capability catalog), so a new tool or capability joins
// the matrix with whatever access it is classified with.

const ORGANIZATION_ID = "org_1";
const USER_ID = "user_1";
const WORKSPACE_ID = "018f2a3e-4b5c-7d6e-8f90-a1b2c3d4e5f6";
/** The surface whose executors serve the whole capability catalog. */
const CAPABILITY_MODE = "advanced" satisfies McpMode;

/** Every feature granted and enrolled, so no target is hidden by a feature gate. */
const enrolledFeatureSnapshot = () =>
  createFeatureAccessSnapshot({
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    decisions: new Map(
      Object.entries(FEATURE_REGISTRY).map(([featureId, definition]) => [
        featureId,
        decideFeatureAccess({
          registry: FEATURE_REGISTRY,
          featureId,
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
          membership: true,
          user: { email: "owner@example.test", emailVerified: true },
          grants: Object.fromEntries(
            Object.keys(FEATURE_REGISTRY).map((id) => [
              id,
              [
                {
                  type: "organization" as const,
                  organizationId: ORGANIZATION_ID,
                },
              ],
            ]),
          ),
          enrolments:
            definition.enrolment === "self-serve"
              ? [
                  {
                    featureId,
                    userId: USER_ID,
                    organizationId: ORGANIZATION_ID,
                  },
                ]
              : [],
        }),
      ]),
    ),
  });

const REFERENCE_VISIBILITY = {
  allVisible: "all-visible",
  noneVisible: "none-visible",
} as const;

type ReferenceVisibility =
  (typeof REFERENCE_VISIBILITY)[keyof typeof REFERENCE_VISIBILITY];

/**
 * A database that answers only the reference-visibility lookup
 * (`select … from … where … limit n`). Any other use means the call got past
 * the agent-access refusal into its handler, and is recorded as stray.
 */
const createReferenceDb = (visibility: ReferenceVisibility) => {
  const stray: string[] = [];
  const state = { lookups: 0, stray };
  const lookup = {
    from: () => ({
      where: () => ({
        limit: async (count: number) => {
          state.lookups += 1;
          return await Promise.resolve(
            visibility === REFERENCE_VISIBILITY.allVisible
              ? Array.from({ length: count }, (_, index) => ({
                  id: `row_${index}`,
                }))
              : [],
          );
        },
      }),
    }),
  };
  const transaction = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "select") {
          return () => lookup;
        }
        if (key === "then") {
          return undefined;
        }
        state.stray.push(String(key));
        return () => panic(`Unexpected database use: ${String(key)}`);
      },
    },
  );
  const scopedDb = asTestRaw<ScopedDb>(
    async (run: (tx: unknown) => Promise<unknown>) => await run(transaction),
  );
  return { scopedDb, state };
};

const createContext = (scopedDb: ScopedDb): McpRequestContext =>
  asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: [toSafeId<"workspace">(WORKSPACE_ID)],
    accessibleWorkspaceIdSet: new Set([WORKSPACE_ID]),
    accessibleWorkspaceStatusById: new Map([[WORKSPACE_ID, "active"]]),
    accessibleWorkspaces: [],
    enabledRegistrySlugs: undefined,
    featureAccessSnapshot: enrolledFeatureSnapshot(),
    grantedScopes: MCP_ALL_RESOURCE_SCOPES,
    memberRole: "owner",
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    recordAuditEvent: async () => await Promise.resolve(undefined),
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    userEmail: "owner@example.test",
    userId: toSafeId<"user">(USER_ID),
  });

// --- Inputs ------------------------------------------------------------------

/**
 * The smallest value a JSON Schema accepts, so a call passes input validation
 * and reaches the step under test. Each id-like string gets its own UUID.
 */
const createMinimalValue = () => {
  let ids = 0;
  const nextUuid = () => {
    ids += 1;
    return `018f2a3e-4b5c-7d6e-8f90-${ids.toString(16).padStart(12, "0")}`;
  };
  const minimalString = (schema: Record<string, unknown>): string => {
    const minLength =
      typeof schema["minLength"] === "number" ? schema["minLength"] : 1;
    const text = "x".repeat(Math.max(minLength, 1));
    const byFormat = new Map([
      ["uuid", nextUuid()],
      ["email", "person@example.test"],
      ["date", "2026-01-15"],
      ["date-time", "2026-01-15T00:00:00.000Z"],
    ]);
    const pattern = schema["pattern"];
    if (typeof pattern !== "string") {
      const format = schema["format"];
      return (typeof format === "string" ? byFormat.get(format) : null) ?? text;
    }
    const matcher = new RegExp(pattern, "u");
    return (
      [...byFormat.values(), text].find((candidate) =>
        matcher.test(candidate),
      ) ?? panic(`No minimal string for ${JSON.stringify(schema)}`)
    );
  };
  const minimal = (schema: unknown): unknown => {
    if (!isRecord(schema)) {
      return undefined;
    }
    if ("const" in schema) {
      return schema["const"];
    }
    if (Array.isArray(schema["enum"])) {
      return schema["enum"].at(0);
    }
    for (const union of [schema["anyOf"], schema["oneOf"]]) {
      if (Array.isArray(union)) {
        return minimal(union.at(0));
      }
    }
    switch (schema["type"]) {
      case "object": {
        const properties = isRecord(schema["properties"])
          ? schema["properties"]
          : {};
        const required = Array.isArray(schema["required"])
          ? schema["required"].filter((key) => typeof key === "string")
          : [];
        return Object.fromEntries(
          required.map((key) => [key, minimal(properties[key])]),
        );
      }
      case "array":
        return Array.from(
          {
            length:
              typeof schema["minItems"] === "number" ? schema["minItems"] : 0,
          },
          () => minimal(schema["items"]),
        );
      case "string":
        return minimalString(schema);
      case "integer":
      case "number":
        return typeof schema["minimum"] === "number" ? schema["minimum"] : 1;
      case "boolean":
        return false;
      case "null":
        return null;
      default:
        return panic(`No minimal value for ${JSON.stringify(schema)}`);
    }
  };
  return minimal;
};

const minimalArgs = (schema: unknown): Record<string, unknown> => {
  const value = createMinimalValue()(schema);
  return isRecord(value) ? value : {};
};

// --- Targets -----------------------------------------------------------------

type ReferenceInput = { schema: unknown; value: unknown };

/** The smallest valid call, and what dispatch checks its references against. */
type MatrixCall = {
  args: Record<string, unknown>;
  referenceInputs: readonly ReferenceInput[];
};

type MatrixTarget = {
  /** The tool name or capability id. */
  name: string;
  mode: McpMode;
  toolName: string;
  target: AgentAccessTarget;
  /** Names the target and nothing else: the refusals a person holds come first. */
  bareArgs: Record<string, unknown>;
  /** Built on demand: only caller-confirmed targets need a valid input. */
  call: () => Promise<MatrixCall>;
};

const toolTargets: MatrixTarget[] = MCP_MODES.flatMap((mode) =>
  listStaticMcpToolDefinitions(mode).map((definition) => ({
    name: definition.name,
    mode,
    toolName: definition.name,
    target: {
      type: "tool",
      name: definition.name,
      access: definition.access,
    } as const satisfies AgentAccessTarget,
    bareArgs: {},
    call: async () => {
      const args = minimalArgs(definition.inputSchema);
      return await Promise.resolve({
        args,
        referenceInputs: [
          {
            schema:
              "inputSchemaSource" in definition
                ? definition.inputSchemaSource
                : definition.inputSchema,
            value: args,
          },
        ],
      });
    },
  })),
);

const CAPABILITY_INPUT_PARTS = ["body", "params", "query"] as const;

const capabilityTargets: MatrixTarget[] = (await loadCapabilityCatalog()).map(
  (entry) => ({
    name: entry.id,
    mode: CAPABILITY_MODE,
    toolName: MCP_CAPABILITY_EXECUTORS[entry.access],
    target: { type: "capability", id: entry.id } as const,
    bareArgs: { capability: entry.id },
    call: async () => {
      const config = (await loadCapabilityEndpoint(entry.id))?.config;
      const referenceInputs = CAPABILITY_INPUT_PARTS.flatMap((part) => {
        const schema = config?.[part];
        return schema === undefined
          ? []
          : [{ part, schema, value: createMinimalValue()(schema) }];
      });
      return {
        args: {
          capability: entry.id,
          input: Object.fromEntries(
            referenceInputs.map(({ part, value }) => [part, value] as const),
          ),
        },
        referenceInputs,
      };
    },
  }),
);

const ALL_TARGETS = [...toolTargets, ...capabilityTargets];

// A caller with a person to ask, as every MCP and CLI client is.
const accessKindOf = ({ target }: MatrixTarget) =>
  describeAgentAccess({ target, context: {} }).access.kind;

/** The refusal each access a person holds is answered with. */
const PERSON_REFUSAL_CODE = {
  [AGENT_ACCESS_KIND.personOnly]: "person_only",
  [AGENT_ACCESS_KIND.personApproves]: "person_approval_required",
} as const satisfies Record<string, AgentCallRefusal["code"]>;

type PersonAccessKind = keyof typeof PERSON_REFUSAL_CODE;

const isPersonAccessKind = (kind: string): kind is PersonAccessKind =>
  Object.hasOwn(PERSON_REFUSAL_CODE, kind);

const personTargets = ALL_TARGETS.flatMap((entry) => {
  const kind = accessKindOf(entry);
  return isPersonAccessKind(kind) ? [{ ...entry, kind }] : [];
});

const callerConfirmsTargets = ALL_TARGETS.filter(
  (entry) => accessKindOf(entry) === AGENT_ACCESS_KIND.callerConfirms,
);

/**
 * Whether the call names a resource the visibility check looks up, read from
 * the check itself against a database where nothing is visible.
 */
const namesCheckedReference = async ({ referenceInputs }: MatrixCall) =>
  !(await resourcesAreVisible({
    inputs: referenceInputs,
    scopedDb: createReferenceDb(REFERENCE_VISIBILITY.noneVisible).scopedDb,
  }));

const errorCodeOf = (result: CallToolResult): string | null => {
  const item = result.content.at(0);
  const payload: unknown = item?.type === "text" ? JSON.parse(item.text) : null;
  const parsed = v.safeParse(
    v.object({ error: v.object({ code: v.string() }) }),
    payload,
  );
  return parsed.success ? parsed.output.error.code : null;
};

const labelOf = ({ name, mode }: MatrixTarget) => `${mode}:${name}`;

describe("the matrix is read from the registries", () => {
  test("both registries contribute targets of every refused kind", () => {
    const kindsBy = (type: AgentAccessTarget["type"]) =>
      new Set(
        ALL_TARGETS.filter((entry) => entry.target.type === type).map(
          accessKindOf,
        ),
      );
    for (const type of ["tool", "capability"] as const) {
      expect(kindsBy(type)).toContain(AGENT_ACCESS_KIND.personOnly);
      expect(kindsBy(type)).toContain(AGENT_ACCESS_KIND.personApproves);
      expect(kindsBy(type)).toContain(AGENT_ACCESS_KIND.callerConfirms);
    }
  });

  test("caller-confirmed targets of both registries name checked references", async () => {
    const referencing = new Set<AgentAccessTarget["type"]>();
    for (const entry of callerConfirmsTargets) {
      if (await namesCheckedReference(await entry.call())) {
        referencing.add(entry.target.type);
      }
    }
    expect([...referencing].toSorted()).toEqual(["capability", "tool"]);
  });
});

describe("a call a person must run or approve", () => {
  test.each(
    personTargets.flatMap((entry) =>
      [false, true].map((confirm) => ({
        ...entry,
        confirm,
        label: labelOf(entry),
      })),
    ),
  )(
    "$label (confirm: $confirm) is refused as $kind before action admission",
    async ({ bareArgs, confirm, kind, mode, toolName }) => {
      const { scopedDb, state } = createReferenceDb(
        REFERENCE_VISIBILITY.allVisible,
      );
      let admissions = 0;
      const result = await callMcpToolOverHttp({
        admitAction: async () => {
          admissions += 1;
          return await Promise.reject(
            new Error("admission must not run for a refused agent call"),
          );
        },
        args: confirm ? { ...bareArgs, confirm: true } : bareArgs,
        context: createContext(scopedDb),
        mode,
        toolName,
      });
      expect({
        code: errorCodeOf(result),
        admissions,
        lookups: state.lookups,
        stray: state.stray,
      }).toEqual({
        code: PERSON_REFUSAL_CODE[kind],
        admissions: 0,
        lookups: 0,
        stray: [],
      });
    },
  );
});

describe("a caller-confirmed call without confirm", () => {
  test.each(
    callerConfirmsTargets.map((entry) => ({ ...entry, label: labelOf(entry) })),
  )(
    "$label asks for confirmation only once its references resolve",
    async (entry) => {
      const matrixCall = await entry.call();
      const call = async (visibility: ReferenceVisibility) => {
        const { scopedDb, state } = createReferenceDb(visibility);
        const result = await callMcpToolOverHttp({
          args: matrixCall.args,
          context: createContext(scopedDb),
          mode: entry.mode,
          toolName: entry.toolName,
        });
        return { code: errorCodeOf(result), stray: state.stray };
      };

      expect(await call(REFERENCE_VISIBILITY.allVisible)).toEqual({
        code: "confirmation_required",
        stray: [],
      });
      // A missing confirmation never answers for a resource the caller
      // cannot see: an invisible reference is reported as not found first.
      expect(await call(REFERENCE_VISIBILITY.noneVisible)).toEqual({
        code: (await namesCheckedReference(matrixCall))
          ? "not_found"
          : "confirmation_required",
        stray: [],
      });
    },
  );
});
