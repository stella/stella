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
 * One rule, pinned identically on both:
 *  - null on a PLAIN optional field (no null in its type) is ABSENCE. The
 *    property is dropped before validation, so the call behaves exactly as if
 *    it had been left out and takes the field's declared default. A strict
 *    client must send every property a schema declares, so reading its null as
 *    a value would make those surfaces uncallable.
 *  - null on a NULLABLE field (declared `type: ["string","null"]` /
 *    `v.optional(v.nullable(...))` / a TypeBox null-union, the "pass null to
 *    clear" convention) is ACCEPTED and passes through as a real null.
 *  - null never reaches a handler as the value of a plain optional field.
 *
 * Only DECLARED optional properties are read this way, so a required field set
 * to null still fails, and a null under a key the schema does not declare is
 * handled exactly as any other value under that key.
 */

const emptyScopedDb = asTestRaw<McpRequestContext["scopedDb"]>(
  async (run: (tx: unknown) => unknown) => {
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => builder,
      for: async () => [],
      orderBy: () => builder,
      limit: async () => [],
      // list_matters reads the org's practice jurisdictions once it gets past
      // argument validation, which a null that reads as absence now does.
      query: {
        organizationSettings: { findFirst: async () => undefined },
      },
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
    testDependencies: { loadOrgSettingsForAuth: loadOrgSettingsMock },
    userId: toSafeId<"user">("user_1"),
  };
};

const loadOrgSettingsMock = mock(async () => ({
  orgAIConfig: null,
  orgAIConfigStatus: "ok" as const,
  promptCachingEnabled: false,
}));
const { handleMcpToolCall } = await import("@/api/mcp/tools");
const capabilityCatalog = (await import("@stll/cli/capability-catalog.json"))
  .default;

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
    args: { capability, input, validate_only: true },
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

describe("static tools read explicit null on plain optional fields as omission", () => {
  // The tool's whole result, so each case requires the null call and the
  // omitted call to be indistinguishable rather than only that the null was
  // not named in an issue. A conditionally required property still reports its
  // own rule (`name is required to create a matter`) in both calls; what this
  // pins is that the null reaches that rule at exactly the same place.
  const outcome = async (tool: string, args: Record<string, unknown>) =>
    JSON.stringify(await call(tool, args));

  const cases: {
    tool: string;
    property: string;
    args: Record<string, unknown>;
  }[] = [
    // Hand-rolled optional parsers (parseOptionalEnum/Limit/Cursor).
    { tool: "list_matters", property: "status", args: {} },
    { tool: "list_matters", property: "limit", args: {} },
    { tool: "list_matters", property: "cursor", args: {} },
    // The detail-branch discriminator: null must list rather than route to a
    // one-matter lookup with no id.
    { tool: "list_matters", property: "matter_id", args: {} },
    // Valibot strict objects with a plain optional property.
    { tool: "save_matter", property: "name", args: {} },
    { tool: "list_documents", property: "mode", args: { matter_id: "ws_1" } },
    { tool: "list_templates", property: "template_id", args: {} },
  ];

  for (const { tool, property, args } of cases) {
    test(`${tool} ${property}: null reads exactly as omitting it`, async () => {
      expect(await outcome(tool, { ...args, [property]: null })).toBe(
        await outcome(tool, args),
      );
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

describe("invoke_capability reads explicit null on plain optional fields as omission", () => {
  // A contact body with everything the schema requires, so each case below
  // differs from its omitted twin in exactly the one null under test.
  const contact = {
    id: "0d0d3b3c-3a55-4f9d-9d3f-2c9b1c9a8f10",
    type: "person",
    displayName: "Ada Lovelace",
  };

  const cases: {
    label: string;
    capability: string;
    withNull: Record<string, unknown>;
    omitted: Record<string, unknown>;
  }[] = [
    {
      label: "time-entries.export-csv query.status",
      capability: "time-entries.export-csv",
      withNull: { params: { matterId: "ws_1" }, query: { status: null } },
      omitted: { params: { matterId: "ws_1" }, query: {} },
    },
    {
      label: "clauses.categories-create body.parentId",
      capability: "clauses.categories-create",
      withNull: { body: { name: "X", parentId: null } },
      omitted: { body: { name: "X" } },
    },
    // One level down: a nested object property, read the same way as the part
    // root so a strict client's nulls do not have to stop at the top level.
    {
      label: "contacts.create body.billingAddress.city",
      capability: "contacts.create",
      withNull: {
        body: {
          ...contact,
          billingAddress: { line1: "1 Main St", city: null },
        },
      },
      omitted: {
        body: { ...contact, billingAddress: { line1: "1 Main St" } },
      },
    },
    // And inside an array of objects.
    {
      label: "contacts.create body.emails[].label",
      capability: "contacts.create",
      withNull: {
        body: {
          ...contact,
          emails: [
            {
              type: "work",
              address: "ada@example.com",
              isPrimary: true,
              label: null,
            },
          ],
        },
      },
      omitted: {
        body: {
          ...contact,
          emails: [
            { type: "work", address: "ada@example.com", isPrimary: true },
          ],
        },
      },
    },
  ];

  for (const { label, capability, withNull, omitted } of cases) {
    test(`${label}: null reads exactly as omitting it`, async () => {
      const result = await invokeValidateOnly(capability, withNull);
      // Asserting validity, not only equality, keeps the case from passing
      // because both calls failed for some unrelated reason.
      expect(parsePayload(result)).toEqual({ valid: true, capability });
      expect(JSON.stringify(result)).toBe(
        JSON.stringify(await invokeValidateOnly(capability, omitted)),
      );
    });
  }

  // A required property is not optional, so its null is still a value the
  // schema rejects, with a dot-path issue an agent can place.
  test("tasks.calendar body.datePropertyIds: null on a required field still fails", async () => {
    const error = errorEnvelope(
      await invokeValidateOnly("tasks.calendar", {
        params: { matterId: "ws_1" },
        body: {
          dateFrom: "2026-01-01T00:00:00.000Z",
          dateTo: "2026-01-31T00:00:00.000Z",
          datePropertyIds: null,
        },
      }),
    );

    expect(error?.code).toBe("validation_error");
    expect(
      error?.issues.some((issue) =>
        issue.path.startsWith("body.datePropertyIds"),
      ),
    ).toBe(true);
    // Refused at validation, before any execution/org-settings load.
    expect(loadOrgSettingsMock).not.toHaveBeenCalled();
  });
});

describe("invoke_capability accepts explicit null on nullable fields", () => {
  // TypeBox null-union fields (catalog `nullable: true`) accept null: Check
  // passes and validate_only reports valid, with the null carried through.
  const cases: {
    label: string;
    capability: string;
    input: Record<string, unknown>;
  }[] = [
    {
      label: "case-law.matter-links.create body.note",
      capability: "case-law.matter-links.create",
      input: {
        params: { matterId: "ws_1" },
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
          matterId: "ws_1",
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
