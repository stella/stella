import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

/**
 * A known LLM-client behavior (Stripe's agent toolkit tests for it explicitly)
 * is sending an explicit JSON `null` for an optional field instead of omitting
 * it. This suite pins how BOTH MCP validation surfaces treat that null, as a
 * regression invariant:
 *
 *  - Static curated tools (`handleMcpToolCall` -> per-tool arg parsing): a mix
 *    of hand-rolled optional parsers (`parseOptionalEnum/Limit/Cursor`, which
 *    test `=== undefined` for absence) and Valibot `v.strictObject` schemas.
 *  - The capability invoke path (`executeInvoke` -> `validatePart`): the
 *    Elysia-parity TypeBox chain Default -> Convert -> Clean -> Check over the
 *    live handler config schemas.
 *
 * Observed, pinned behavior (identical intent on both paths):
 *  - null on a PLAIN optional field (no null in its type) is REJECTED with a
 *    clean `validation_error` envelope carrying `issues:[{path,message}]` an
 *    agent can self-correct from. null is never silently coerced to "absent",
 *    and never leaks past validation into a handler.
 *  - null on a NULLABLE field (declared `type: ["string","null"]` /
 *    `v.optional(v.nullable(...))` / a TypeBox null-union, the "pass null to
 *    clear" convention) is ACCEPTED and passes through as a real null.
 *
 * No path was found where null leaks past validation into a handler.
 */

const emptyScopedDb = asTestRaw<McpRequestContext["scopedDb"]>(
  async (run: (tx: unknown) => unknown) => {
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: async () => [],
    };
    return await run(builder);
  },
);

const noopRecorder = asTestRaw<AuditRecorder>(mock(async () => undefined));

const createContext = (): McpRequestContext => {
  const workspaceIds = ["ws_1"];
  const set = new Set(workspaceIds);
  const safeDb = toSafeDbMock(emptyScopedDb);
  return {
    accessibleWorkspaceIds: workspaceIds.map((id) => toSafeId<"workspace">(id)),
    accessibleWorkspaceIdSet: set,
    accessibleWorkspaceStatusById: new Map(
      workspaceIds.map((id) => [id, "active"]),
    ),
    accessibleWorkspaces: workspaceIds.map((id) => ({
      id: toSafeId<"workspace">(id),
      status: "active" as const,
    })),
    createOperationDatabaseScope: () => ({
      pinServerValidatedWorkspaceId: (workspaceId) => set.has(workspaceId),
      safeDb,
      scopedDb: emptyScopedDb,
    }),
    grantedScopes: [
      "stella:read",
      "stella:billing_write",
      "stella:contacts_write",
      "stella:knowledge_write",
      "stella:matters_write",
    ],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    request: new Request("http://localhost/mcp"),
    recordAuditEvent: noopRecorder,
    safeDb,
    scopedDb: emptyScopedDb,
    userId: toSafeId<"user">("user_1"),
  };
};

const loadOrgSettingsMock = mock(async () => ({
  orgAIConfig: null,
  promptCachingEnabled: false,
}));
const realLoader = await import("@/api/lib/ai-config-loader");
void mock.module("@/api/lib/ai-config-loader", () => ({
  ...realLoader,
  loadOrgSettingsForAuth: loadOrgSettingsMock,
}));

const { handleMcpToolCall } = await import("@/api/mcp/tools");
const capabilityCatalog = (
  await import("@/api/mcp/generated/capability-catalog.json")
).default;

type ToolResult = Awaited<ReturnType<typeof handleMcpToolCall>>;

const parsePayload = (result: ToolResult): unknown => {
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  return JSON.parse(item.text) as unknown;
};

// A structured envelope's text is always JSON; a legacy plain-text `errorResult`
// (e.g. a handler surfacing a captured error message) is not. Return undefined
// for the latter so callers can treat "handler ran, non-envelope result" as
// distinct from a structured envelope.
const tryParsePayload = (result: ToolResult): unknown => {
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    return undefined;
  }
  try {
    return JSON.parse(item.text) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Issue = { path: string; message: string };

// The `error` object of a structured `{ error: { code, message, issues? } }`
// envelope, or null when the result is not a structured envelope (e.g. a legacy
// plain-text `errorResult`, or a success payload).
const errorEnvelope = (
  result: ToolResult,
): { code: string; message: string; issues: Issue[] } | null => {
  const payload = tryParsePayload(result);
  if (!isRecord(payload) || !isRecord(payload["error"])) {
    return null;
  }
  const error = payload["error"];
  const rawIssues = error["issues"];
  const issues: Issue[] = Array.isArray(rawIssues)
    ? rawIssues.flatMap((issue) =>
        isRecord(issue) &&
        typeof issue["path"] === "string" &&
        typeof issue["message"] === "string"
          ? [{ path: issue["path"], message: issue["message"] }]
          : [],
      )
    : [];
  return {
    code: typeof error["code"] === "string" ? error["code"] : "",
    message: typeof error["message"] === "string" ? error["message"] : "",
    issues,
  };
};

const call = async (toolName: string, args: Record<string, unknown>) =>
  await handleMcpToolCall({ args, context: createContext(), toolName });

const invokeValidateOnly = async (
  capability: string,
  input: Record<string, unknown>,
) =>
  await handleMcpToolCall({
    args: { capability, input, validateOnly: true },
    context: createContext(),
    toolName: "invoke_capability",
  });

beforeEach(() => {
  loadOrgSettingsMock.mockClear();
});

// --- Premise guard: the representative examples below stay meaningful only if
// the catalog actually still carries both nullable and plain-optional fields.
describe("null-tolerance premise", () => {
  test("the capability catalog carries both nullable and plain-optional fields", () => {
    let nullableFields = 0;
    let plainOptionalStringFields = 0;
    for (const entry of capabilityCatalog) {
      const schema = entry.inputSchema;
      if (!isRecord(schema)) {
        continue;
      }
      for (const part of ["body", "params", "query"] as const) {
        const partSchema = schema[part];
        if (!isRecord(partSchema) || !isRecord(partSchema.properties)) {
          continue;
        }
        for (const prop of Object.values(partSchema.properties)) {
          const json = JSON.stringify(prop);
          if (json.includes('"type":"null"')) {
            nullableFields += 1;
          } else if (json.includes('"type":"string"')) {
            plainOptionalStringFields += 1;
          }
        }
      }
    }
    expect(nullableFields).toBeGreaterThan(0);
    expect(plainOptionalStringFields).toBeGreaterThan(0);
  });
});

// --- Path 1: static curated tools -------------------------------------------

describe("static tools reject explicit null on plain optional fields", () => {
  // Hand-rolled optional parsers key absence off `value === undefined`, so an
  // explicit null falls through to the type check and is rejected. list_matters
  // routes status/limit/cursor through parseOptionalEnum/Limit/Cursor.
  const handRolledCases: { field: string; value: null }[] = [
    { field: "status", value: null },
    { field: "limit", value: null },
    { field: "cursor", value: null },
  ];

  for (const { field, value } of handRolledCases) {
    test(`list_matters ${field}: null -> validation_error naming ${field}`, async () => {
      const error = errorEnvelope(
        await call("list_matters", { [field]: value }),
      );
      expect(error?.code).toBe("validation_error");
      expect(error?.issues.some((issue) => issue.path === field)).toBe(true);
    });
  }

  // matter_id: null is NOT undefined, so list_matters enters its detail branch
  // (`args["matter_id"] !== undefined`) and rejects the null as a missing
  // required id rather than silently listing.
  test("list_matters matter_id: null -> validation_error (routed to detail branch)", async () => {
    const error = errorEnvelope(
      await call("list_matters", { matter_id: null }),
    );
    expect(error?.code).toBe("validation_error");
    expect(error?.issues.some((issue) => issue.path === "matter_id")).toBe(
      true,
    );
  });

  // Valibot v.strictObject with a plain optional field: null is not the field's
  // type, so safeParse fails at the boundary (before any workspace/DB access)
  // with a field-scoped issue.
  const valibotCases: {
    tool: string;
    args: Record<string, unknown>;
    path: string;
  }[] = [
    { tool: "save_matter", args: { name: null }, path: "name" },
    {
      tool: "list_documents",
      args: { matter_id: "ws_1", mode: null },
      path: "mode",
    },
  ];

  for (const { tool, args, path } of valibotCases) {
    test(`${tool} ${path}: null -> validation_error naming ${path}`, async () => {
      const error = errorEnvelope(await call(tool, args));
      expect(error?.code).toBe("validation_error");
      expect(error?.issues.some((issue) => issue.path === path)).toBe(true);
      // Rejected at the schema boundary: no handler ran.
      expect(loadOrgSettingsMock).not.toHaveBeenCalled();
    });
  }
});

describe("static tools accept explicit null on nullable ('pass null to clear') fields", () => {
  // save_matter.billing_reference is v.optional(v.nullable(...)): null is a
  // valid value, so it PASSES the schema and reaches the handler as a real null
  // (the clear semantic). It is therefore never rejected as a validation_error
  // that names billing_reference; the downstream handler drives the DB.
  test("save_matter billing_reference: null is not rejected at the schema boundary", async () => {
    const error = errorEnvelope(
      await call("save_matter", {
        matter_id: "ws_1",
        billing_reference: null,
      }),
    );
    // Either a non-structured result (handler ran) or, if structured, NOT a
    // validation_error naming billing_reference: the null cleared schema.
    const rejectedForNull =
      error?.code === "validation_error" &&
      error.issues.some((issue) => issue.path === "billing_reference");
    expect(rejectedForNull).toBe(false);
  });
});

// --- Path 2: capability invoke path (TypeBox Default->Convert->Clean->Check) --

describe("invoke_capability rejects explicit null on plain optional fields", () => {
  // Each case sets one plain (non-nullable) optional field to null; the TypeBox
  // Check fails and the envelope carries a dot-path issue an agent can place.
  const cases: {
    label: string;
    capability: string;
    input: Record<string, unknown>;
    pathPrefix: string;
  }[] = [
    {
      label: "time-entries.export-csv query.status",
      capability: "time-entries.export-csv",
      input: { params: { workspaceId: "ws_1" }, query: { status: null } },
      pathPrefix: "query.status",
    },
    {
      label: "clauses.categories-create body.parentId",
      capability: "clauses.categories-create",
      input: { body: { name: "X", parentId: null } },
      pathPrefix: "body.parentId",
    },
    {
      label: "tasks.calendar body.datePropertyIds",
      capability: "tasks.calendar",
      input: {
        params: { workspaceId: "ws_1" },
        body: {
          dateFrom: "2026-01-01T00:00:00.000Z",
          dateTo: "2026-01-31T00:00:00.000Z",
          datePropertyIds: null,
        },
      },
      pathPrefix: "body.datePropertyIds",
    },
  ];

  for (const { label, capability, input, pathPrefix } of cases) {
    test(`${label}: null -> validation_error with a dot-path issue`, async () => {
      const error = errorEnvelope(await invokeValidateOnly(capability, input));
      expect(error?.code).toBe("validation_error");
      expect(
        error?.issues.some((issue) => issue.path.startsWith(pathPrefix)),
      ).toBe(true);
      // Refused at validation, before any execution/org-settings load.
      expect(loadOrgSettingsMock).not.toHaveBeenCalled();
    });
  }
});

describe("invoke_capability accepts explicit null on nullable fields", () => {
  // TypeBox null-union fields (catalog `nullable: true`) accept null: Check
  // passes and validateOnly reports valid, with the null carried through.
  const cases: {
    label: string;
    capability: string;
    input: Record<string, unknown>;
  }[] = [
    {
      label: "case-law.matter-links.create body.note",
      capability: "case-law.matter-links.create",
      input: {
        params: { workspaceId: "ws_1" },
        body: {
          decisionId: "00000000-0000-0000-0000-000000000000",
          note: null,
        },
      },
    },
    {
      label: "contacts.update body.firstName",
      capability: "contacts.update",
      input: {
        params: {
          workspaceId: "ws_1",
          contactId: "00000000-0000-0000-0000-000000000000",
        },
        body: { firstName: null },
      },
    },
  ];

  for (const { label, capability, input } of cases) {
    test(`${label}: null -> valid (accepted, not coerced away)`, async () => {
      const result = await invokeValidateOnly(capability, input);
      expect(errorEnvelope(result)).toBeNull();
      expect(parsePayload(result)).toEqual({ valid: true, capability });
    });
  }
});
