import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpEgressPlan } from "@/api/mcp/tool-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

/**
 * Registry-driven canary corpus over the MCP anonymized surface (plan 049,
 * Phase 0). This is the structural guard for the bug class both shipped
 * leaks shared: a tool's `textFields` declaration and its handler's actual
 * `McpStructuredTextField` pushes are hand-maintained twins with nothing
 * forcing them to describe the same fields (Wave 1: `read_document` declared
 * `versions[].label`/`description` but never pushed them; Wave 4: a
 * fail-closed guard in `readClauseDetail` could skip a push entirely).
 *
 * Mechanics: for every tool the registry marks `exposure: "anonymize"`, a
 * fixture seeds a unique per-declared-field token into the handler's backing
 * store (a minimal scopedDb/safeDb test double, or a mocked plain backing
 * function for a handful of workspace/template lookups), calls the real
 * exported tool handler directly (`<MODULE>_TOOL_HANDLERS.<name>`, bypassing
 * only the outer schema/permission dispatch in `tools.ts`), and runs the
 * result through the real, unmocked `finalizeMcpEgress` in anonymized mode.
 * Two assertions close the loop: (a) no seed token survives anywhere in the
 * serialized result (no leak), and (b) every seed token was actually queued
 * into an `anonymizeTextFields` call (proving the declared field was really
 * pushed by production code, not merely documented). Checking (b) against the
 * anonymizer's call arguments rather than walking the output by path string
 * sidesteps a real wrinkle found while building this: several declared paths
 * (e.g. `fields[].value`) do not literally address the JSON the handler
 * returns (the real shape nests under `fields[].content.value`); the
 * declared strings are documentation of intent, not a parseable path
 * grammar, so a literal path-walker would be exactly as fragile here as the
 * design brief's Option A predicts.
 *
 * `CANARY_COVERED_TOOL_NAMES` is checked against the live registry
 * enumeration in the completeness test below: a tool added to the anonymized
 * surface without a matching entry here fails a red build, closing the
 * "someone forgot" gap the design brief calls out for Option C.
 *
 * Known, stated blind spot: `read_document`'s `compare_with_version_id`
 * (diff) branch loads DOCX bytes from S3 through `loadEntityVersionDocxText`
 * and diffs them with `buildLineDiffSegments`. Driving that for real needs an
 * actual DOCX fixture and an S3 double, which is out of scope for this
 * corpus; that one sub-case (`diff.segments[].text`) is exercised at the
 * egress-plan level instead of through the real handler (see the dedicated
 * test below). Every other declared field on every other tool, including
 * both compat variants, runs through the real production handler.
 */

// --- Shared anonymization/backing-handler mocks -----------------------

type AnonymizeTextFieldsInput = {
  fields: readonly string[];
  gazetteerEntries?: unknown;
  organizationId?: unknown;
  scopedDb?: unknown;
  workspaceId?: unknown;
};

const anonymizeTextFieldsMock = mock(
  async ({ fields }: AnonymizeTextFieldsInput) => ({
    entityCount: fields.length,
    fields: fields.map((_field, index) => `[ANON_${index}]`),
  }),
);

const loadAnonymizationGazetteerEntriesMock = mock(async () => []);

const decryptContentMock = mock(async () => "");

type SearchProviderHit = {
  entityId: string;
  headline?: string | null;
  kind?: string;
  title: string;
  workspaceId: string;
  workspaceName?: string;
};

const searchProviderSearchMock = mock(
  async (): Promise<{
    hits: SearchProviderHit[];
    nextCursor: string | null;
    totalCount: number;
  }> => ({ hits: [], nextCursor: null, totalCount: 0 }),
);

const readWorkspaceHandlerMock = mock();
const readOverviewHandlerMock = mock();
const readWorkspaceContactsHandlerMock = mock();
const readWorkspaceMembersHandlerMock = mock();
const describeStoredTemplateMock = mock();

const realAnonymizationBlacklist =
  await import("@/api/lib/anonymization-blacklist");
const realContentEncryption = await import("@/api/lib/content-encryption");
const realTemplateFillService =
  await import("@/api/handlers/templates/template-fill-service");

void mock.module("@/api/mcp/anonymization", () => ({
  anonymizeTextFields: anonymizeTextFieldsMock,
}));

void mock.module("@/api/lib/anonymization-blacklist", () => ({
  ...realAnonymizationBlacklist,
  loadAnonymizationGazetteerEntries: loadAnonymizationGazetteerEntriesMock,
}));

void mock.module("@/api/lib/content-encryption", () => ({
  ...realContentEncryption,
  decryptContent: decryptContentMock,
}));

void mock.module("@/api/lib/search/provider", () => ({
  getSearchProvider: () => ({ search: searchProviderSearchMock }),
}));

void mock.module("@/api/handlers/workspaces/read-by-id", () => ({
  readWorkspaceHandler: readWorkspaceHandlerMock,
}));

void mock.module("@/api/handlers/workspaces/read-overview", () => ({
  readOverviewHandler: readOverviewHandlerMock,
}));

void mock.module("@/api/handlers/workspaces/workspace-contacts-read", () => ({
  readWorkspaceContactsHandler: readWorkspaceContactsHandlerMock,
}));

void mock.module("@/api/handlers/workspaces/workspace-members-read", () => ({
  readWorkspaceMembersHandler: readWorkspaceMembersHandlerMock,
}));

void mock.module("@/api/handlers/templates/template-fill-service", () => ({
  ...realTemplateFillService,
  describeStoredTemplate: describeStoredTemplateMock,
}));

const { finalizeMcpEgress } = await import("@/api/mcp/egress");
const { ANONYMIZED_MCP_TOOL_DEFINITIONS } =
  await import("@/api/mcp/static-tool-definitions");
const { COMPAT_TOOL_HANDLERS } = await import("@/api/mcp/compat-tools");
const { STELLA_TOOL_HANDLERS } = await import("@/api/mcp/stella-tools");
const { DOCUMENT_TOOL_HANDLERS } = await import("@/api/mcp/document-tools");
const { MATTER_TOOL_HANDLERS } = await import("@/api/mcp/matter-tools");
const { TEMPLATE_TOOL_HANDLERS } = await import("@/api/mcp/template-tools");
const { BILLING_TOOL_HANDLERS } = await import("@/api/mcp/billing-tools");
const { KNOWLEDGE_TOOL_HANDLERS } = await import("@/api/mcp/knowledge-tools");

// --- Fixture harness ----------------------------------------------------

/** A unique, greppable token for one tool's one declared textFields entry. */
const mkSeed = (tool: string, index: number): string =>
  `SEED_${tool}_${index}_TOKEN`;

type ChainableRows = {
  from: (...args: unknown[]) => ChainableRows;
  where: (...args: unknown[]) => ChainableRows;
  orderBy: (...args: unknown[]) => ChainableRows;
  innerJoin: (...args: unknown[]) => ChainableRows;
  leftJoin: (...args: unknown[]) => ChainableRows;
  limit: (...args: unknown[]) => Promise<readonly unknown[]>;
};

/**
 * A drizzle-shaped select chain covering every query in this corpus that
 * terminates at `.limit()`: every non-terminal method (`from`, `where`,
 * `orderBy`, the joins) returns the same synchronous builder, and the
 * terminal `.limit()` resolves to `rows`. The one query with no page limit
 * (the `loadUserNames` join inside `list_time_entries`) uses the bespoke
 * builder next to its call site instead, since a method cannot be both a
 * synchronous, further-chainable step and an awaitable terminus.
 */
const chainableRows = (rows: readonly unknown[]): ChainableRows => {
  const builder: ChainableRows = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    innerJoin: () => builder,
    leftJoin: () => builder,
    limit: async () => rows,
  };
  return builder;
};

/**
 * A `tx.select` stand-in for a join query with no page limit, terminating at
 * `.where()` (the compat `search` tool's fetchable-entity join). Mirrors
 * `chainableRows` but with an awaitable terminal `.where()` instead of
 * `.limit()`.
 */
const chainableJoinRows = (rows: readonly unknown[]) => ({
  from: () => ({
    innerJoin: () => ({
      leftJoin: () => ({ where: async () => rows }),
    }),
  }),
});

/**
 * A `tx.select` stand-in for `list_time_entries`, whose handler runs two
 * distinct select queries against one scopedDb double inside a single call:
 * the entries page (terminates at `.limit()`), then a join resolving each
 * entry's user display name (terminates at `.where()`, no page limit). Each
 * call to the returned function advances to the next query, in the order
 * the handler issues them; the counter lives on a boxed object the factory
 * closes over so repeated calls advance correctly.
 */
const createEntriesAndUserNamesSelect = ({
  entryRows,
  userNameRows,
}: {
  entryRows: readonly unknown[];
  userNameRows: readonly unknown[];
}) => {
  const state = { call: 0 };
  return (..._args: unknown[]) => {
    state.call += 1;
    if (state.call === 1) {
      return chainableRows(entryRows);
    }
    return {
      from: () => ({
        innerJoin: () => ({
          where: async () => userNameRows,
        }),
      }),
    };
  };
};

const buildContext = ({
  memberRole = "owner",
  organizationId = "org_1",
  tx = {},
  workspaceIds = ["ws_1"],
}: {
  memberRole?: McpRequestContext["memberRole"];
  organizationId?: string;
  tx?: unknown;
  workspaceIds?: readonly string[];
} = {}): McpRequestContext => {
  const { safeDb, scopedDb } = createScopedDbMock(tx);
  return {
    accessibleWorkspaceIds: workspaceIds.map((id) => toSafeId<"workspace">(id)),
    accessibleWorkspaceIdSet: new Set(workspaceIds),
    accessibleWorkspaceStatusById: new Map(
      workspaceIds.map((id) => [id, "active"]),
    ),
    memberRole,
    organizationId: toSafeId<"organization">(organizationId),
    recordAuditEvent: asTestRaw(mock(async () => undefined)),
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
  };
};

const parseResultText = (result: CallToolResult): string => {
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  return item.text;
};

/** Runs a handler's response through the real anonymized egress pipeline. */
const finalize = async (
  context: McpRequestContext,
  response: Awaited<ReturnType<typeof COMPAT_TOOL_HANDLERS.search>>,
) => await finalizeMcpEgress({ context, mode: "anonymized", response });

const expectNoSeedLeak = (
  result: CallToolResult,
  seeds: readonly string[],
): void => {
  const text = parseResultText(result);
  for (const seed of seeds) {
    expect(
      text,
      `Seed ${seed} leaked into the anonymized result`,
    ).not.toContain(seed);
  }
};

/**
 * The precise, surgical replacement for a path-walker: every declared field
 * must have actually reached an `anonymizeTextFields` call, proving the
 * handler queued it for redaction rather than merely documenting it in
 * `textFields`. A seed missing here reproduces the Wave 1 class of bug
 * (declared, never pushed) without needing to resolve the declared path
 * string against the handler's real JSON shape.
 */
const expectSeedsQueuedForAnonymization = (seeds: readonly string[]): void => {
  const queued = anonymizeTextFieldsMock.mock.calls.flatMap(
    (call) => call[0].fields,
  );
  for (const seed of seeds) {
    expect(queued, `Expected ${seed} to be queued for anonymization`).toContain(
      seed,
    );
  }
};

beforeEach(() => {
  anonymizeTextFieldsMock.mockClear();
  loadAnonymizationGazetteerEntriesMock.mockReset();
  loadAnonymizationGazetteerEntriesMock.mockResolvedValue([]);
  decryptContentMock.mockReset();
  searchProviderSearchMock.mockReset();
  searchProviderSearchMock.mockResolvedValue({
    hits: [],
    nextCursor: null,
    totalCount: 0,
  });
  readWorkspaceHandlerMock.mockReset();
  readOverviewHandlerMock.mockReset();
  readWorkspaceContactsHandlerMock.mockReset();
  readWorkspaceMembersHandlerMock.mockReset();
  describeStoredTemplateMock.mockReset();
});

afterAll(() => {
  mock.restore();
});

/**
 * Tools this file has a canary fixture for, checked below against every
 * `exposure: "anonymize"` tool the live registry advertises. A tool added to
 * the anonymized surface without an entry here fails the build instead of
 * shipping unguarded.
 */
const CANARY_COVERED_TOOL_NAMES = new Set([
  "search",
  "fetch",
  "list_matters",
  "search_across_matters",
  "read_content_across_matters",
  "read_contact",
  "list_templates",
  "list_documents",
  "read_document",
  "list_properties",
  "list_tasks",
  "list_clauses",
  "list_playbooks",
  "list_time_entries",
  "list_invoices",
]);

describe("MCP anonymization canary corpus", () => {
  test("every anonymize-mode tool in the registry has a canary fixture", () => {
    const anonymizeToolNames = ANONYMIZED_MCP_TOOL_DEFINITIONS.filter(
      (tool) => tool.anonymized.exposure === "anonymize",
    ).map((tool) => tool.name);

    const missing = anonymizeToolNames.filter(
      (name) => !CANARY_COVERED_TOOL_NAMES.has(name),
    );

    expect(
      missing,
      "A tool joined the anonymized surface without a canary fixture in " +
        "egress-canary.test.ts. Add one before merging.",
    ).toEqual([]);

    // Guards the guard: a typo'd or stale name in the covered set that no
    // longer matches a real anonymize-mode tool would otherwise hide a gap.
    const extra = [...CANARY_COVERED_TOOL_NAMES].filter(
      (name) => !anonymizeToolNames.includes(name),
    );
    expect(
      extra,
      "CANARY_COVERED_TOOL_NAMES names a tool that is not (or no longer) " +
        "anonymize-mode in the registry.",
    ).toEqual([]);
  });

  // --- compat: search / fetch -------------------------------------------

  test("compat search anonymizes result titles", async () => {
    const tool = "search";
    const titleSeed = mkSeed(tool, 0);
    searchProviderSearchMock.mockResolvedValue({
      hits: [
        {
          entityId: "entity_1",
          workspaceId: "ws_1",
          title: titleSeed,
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
    const tx = {
      select: () =>
        chainableJoinRows([
          { entityId: "entity_1", workspaceId: "ws_1", fieldId: "field_1" },
        ]),
    };
    const context = buildContext({ tx });

    const response = await COMPAT_TOOL_HANDLERS.search({
      args: { query: "q" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [titleSeed]);
    expectSeedsQueuedForAnonymization([titleSeed]);
  });

  test("compat fetch anonymizes title and text", async () => {
    const tool = "fetch";
    const titleSeed = mkSeed(tool, 0);
    const textSeed = mkSeed(tool, 1);
    decryptContentMock.mockResolvedValue(textSeed);
    const tx = {
      query: {
        entities: { findFirst: async () => null },
        extractedContent: {
          findFirst: async () => ({
            charCount: textSeed.length,
            ciphertext: "cipher",
            iv: "iv",
            entity: { name: titleSeed, workspaceId: "ws_1" },
          }),
        },
      },
    };
    const context = buildContext({ tx });

    const response = await COMPAT_TOOL_HANDLERS.fetch({
      args: { id: "entity_1" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [titleSeed, textSeed]);
    expectSeedsQueuedForAnonymization([titleSeed, textSeed]);
  });

  // --- stella-tools --------------------------------------------------------

  test("list_matters (list mode) anonymizes matter names", async () => {
    const tool = "list_matters";
    const nameSeed = mkSeed(tool, 0);
    const tx = {
      select: () =>
        chainableRows([
          {
            id: "ws_1",
            name: nameSeed,
            reference: "REF-1",
            status: "active",
            lastActivityAt: new Date("2026-01-01"),
            createdAt: new Date("2026-01-01"),
          },
        ]),
    };
    const context = buildContext({ tx });

    const response = await STELLA_TOOL_HANDLERS.list_matters({
      args: {},
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [nameSeed]);
    expectSeedsQueuedForAnonymization([nameSeed]);
  });

  test("list_matters (detail mode) anonymizes matter, overview, contacts, and members", async () => {
    const tool = "list_matters";
    const matterNameSeed = mkSeed(tool, 1);
    const clientNameSeed = mkSeed(tool, 2);
    const recentNameSeed = mkSeed(tool, 3);
    const createdBySeed = mkSeed(tool, 4);
    const assignedToSeed = mkSeed(tool, 5);
    const contactDisplayNameSeed = mkSeed(tool, 6);
    const memberNameSeed = mkSeed(tool, 7);

    readWorkspaceHandlerMock.mockResolvedValue({
      id: "ws_1",
      name: matterNameSeed,
      reference: "REF-1",
      status: "active",
      client: { displayName: clientNameSeed },
    });
    readOverviewHandlerMock.mockResolvedValue({
      entityCount: 1,
      documentCount: 1,
      taskCount: 0,
      recentEntities: [
        {
          entityId: "entity_1",
          name: recentNameSeed,
          kind: "document",
          status: null,
          priority: null,
          dueDate: null,
          mimeType: null,
          fieldId: null,
          propertyId: null,
          pdfFileId: null,
          encrypted: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: null,
          createdBy: createdBySeed,
          createdByImage: null,
          createdByDeletedAt: null,
          assignedTo: assignedToSeed,
          assignedToImage: null,
          assignedToDeletedAt: null,
        },
      ],
    });
    readWorkspaceContactsHandlerMock.mockResolvedValue([
      {
        id: "wc_1",
        role: "client",
        contact: {
          id: "contact_1",
          type: "person",
          displayName: contactDisplayNameSeed,
        },
      },
    ]);
    readWorkspaceMembersHandlerMock.mockResolvedValue([
      {
        id: "wm_1",
        userId: "user_2",
        createdAt: new Date("2026-01-01"),
        user: {
          id: "user_2",
          name: memberNameSeed,
          email: "member@example.test",
          image: null,
        },
      },
    ]);

    const context = buildContext();
    const response = await STELLA_TOOL_HANDLERS.list_matters({
      args: { matter_id: "ws_1" },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [
      matterNameSeed,
      clientNameSeed,
      recentNameSeed,
      createdBySeed,
      assignedToSeed,
      contactDisplayNameSeed,
      memberNameSeed,
    ];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  test("search_across_matters anonymizes hit name, headline, and workspace name", async () => {
    const tool = "search_across_matters";
    const nameSeed = mkSeed(tool, 0);
    const headlineSeed = mkSeed(tool, 1);
    const workspaceNameSeed = mkSeed(tool, 2);
    searchProviderSearchMock.mockResolvedValue({
      hits: [
        {
          entityId: "entity_1",
          workspaceId: "ws_1",
          title: nameSeed,
          headline: headlineSeed,
          workspaceName: workspaceNameSeed,
          kind: "document",
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
    const context = buildContext();

    const response = await STELLA_TOOL_HANDLERS.search_across_matters({
      args: { query: "q" },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [nameSeed, headlineSeed, workspaceNameSeed];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  test("read_content_across_matters anonymizes entity name and text", async () => {
    const tool = "read_content_across_matters";
    const nameSeed = mkSeed(tool, 0);
    const textSeed = mkSeed(tool, 1);
    decryptContentMock.mockResolvedValue(textSeed);
    const tx = {
      query: {
        extractedContent: {
          findFirst: async () => ({
            ciphertext: "cipher",
            iv: "iv",
            entity: { kind: "document", name: nameSeed, workspaceId: "ws_1" },
          }),
        },
      },
    };
    const context = buildContext({ tx });

    const response = await STELLA_TOOL_HANDLERS.read_content_across_matters({
      args: { entity_id: "entity_1" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [nameSeed, textSeed]);
    expectSeedsQueuedForAnonymization([nameSeed, textSeed]);
  });

  test("read_contact anonymizes name, org, email, and phone fields", async () => {
    const tool = "read_contact";
    const displayNameSeed = mkSeed(tool, 0);
    const firstNameSeed = mkSeed(tool, 1);
    const lastNameSeed = mkSeed(tool, 2);
    const organizationNameSeed = mkSeed(tool, 3);
    const emailSeed = mkSeed(tool, 4);
    const phoneSeed = mkSeed(tool, 5);
    const tx = {
      query: {
        contacts: {
          findFirst: async () => ({
            id: "contact_1",
            type: "person",
            displayName: displayNameSeed,
            firstName: firstNameSeed,
            lastName: lastNameSeed,
            organizationName: organizationNameSeed,
            emails: [{ label: "work", address: emailSeed }],
            phones: [{ label: "mobile", number: phoneSeed }],
          }),
        },
      },
    };
    const context = buildContext({ tx });

    const response = await STELLA_TOOL_HANDLERS.read_contact({
      args: { contact_id: "contact_1" },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [
      displayNameSeed,
      firstNameSeed,
      lastNameSeed,
      organizationNameSeed,
      emailSeed,
      phoneSeed,
    ];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  // --- document-tools ------------------------------------------------------

  test("list_documents anonymizes document names", async () => {
    const tool = "list_documents";
    const nameSeed = mkSeed(tool, 0);
    const tx = {
      select: () =>
        chainableRows([
          {
            createdAt: "2026-01-01T00:00:00.000000",
            id: "doc_1",
            name: nameSeed,
            kind: "document",
            parentId: null,
          },
        ]),
    };
    const context = buildContext({ tx });

    const response = await DOCUMENT_TOOL_HANDLERS.list_documents({
      args: { matter_id: "ws_1" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [nameSeed]);
    expectSeedsQueuedForAnonymization([nameSeed]);
  });

  test("read_document (default + version history) anonymizes name, field values, and version labels", async () => {
    const tool = "read_document";
    const nameSeed = mkSeed(tool, 0);
    const fieldValueSeed = mkSeed(tool, 1);
    const versionLabelSeed = mkSeed(tool, 3);
    const versionDescriptionSeed = mkSeed(tool, 4);
    const tx = {
      query: {
        entities: {
          findFirst: async () => ({
            workspaceId: "ws_1",
            kind: "document",
            name: nameSeed,
            currentVersionId: "ver_current",
          }),
        },
        fields: {
          findMany: async () => [
            {
              id: "field_1",
              propertyId: "prop_1",
              content: { version: 1, type: "text", value: fieldValueSeed },
            },
          ],
        },
      },
      select: () =>
        chainableRows([
          {
            id: "ver_2",
            versionNumber: 2,
            stamp: null,
            label: versionLabelSeed,
            description: versionDescriptionSeed,
            createdAt: new Date("2026-01-01"),
          },
        ]),
    };
    const context = buildContext({ tx });

    const response = await DOCUMENT_TOOL_HANDLERS.read_document({
      args: { entity_id: "entity_1", include_versions: true },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [
      nameSeed,
      fieldValueSeed,
      versionLabelSeed,
      versionDescriptionSeed,
    ];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  test("read_document (specific version) anonymizes that version's field values", async () => {
    const tool = "read_document";
    const versionFieldValueSeed = mkSeed(tool, 2);
    const tx = {
      query: {
        entities: {
          findFirst: async () => ({
            workspaceId: "ws_1",
            kind: "document",
            name: "Doc",
            currentVersionId: "ver_current",
          }),
        },
        entityVersions: {
          findFirst: async () => ({
            id: "ver_1",
            versionNumber: 1,
            stamp: null,
            label: null,
            description: null,
            createdAt: new Date("2026-01-01"),
          }),
        },
        fields: {
          findMany: async () => [
            {
              id: "field_2",
              propertyId: "prop_2",
              content: {
                version: 1,
                type: "text",
                value: versionFieldValueSeed,
              },
            },
          ],
        },
      },
    };
    const context = buildContext({ tx });

    const response = await DOCUMENT_TOOL_HANDLERS.read_document({
      args: { entity_id: "entity_1", version_id: "ver_1" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [versionFieldValueSeed]);
    expectSeedsQueuedForAnonymization([versionFieldValueSeed]);
  });

  // read_document's compare_with_version_id branch diffs two DOCX versions
  // loaded from S3 (loadEntityVersionDocxText -> buildLineDiffSegments).
  // Driving that for real needs an actual DOCX fixture and an S3 double,
  // which this corpus does not attempt (see the file-level blind-spot note).
  // This sub-case is exercised at the egress-plan level instead: the plan
  // shape below mirrors exactly what the diff branch builds
  // (`document-tools.ts`'s `handleReadDocumentTool`, compare branch).
  test("read_document (diff, egress-plan level) anonymizes diff segment text", async () => {
    const tool = "read_document";
    const diffSeed = mkSeed(tool, 5);
    const diffSegment = { kind: "unchanged" as const, text: diffSeed };
    const payload = {
      entityId: "entity_1",
      name: "Doc",
      diff: {
        baseVersionId: "ver_a",
        targetVersionId: "ver_b",
        segments: [diffSegment],
      },
    };
    const plan: McpEgressPlan = {
      egress: "structured",
      payload,
      textFields: [
        {
          apply: (value: string) => {
            diffSegment.text = value;
          },
          value: diffSeed,
          workspaceId: "ws_1",
        },
      ],
    };
    const context = buildContext();

    const result = await finalizeMcpEgress({
      context,
      mode: "anonymized",
      response: plan,
    });

    expectNoSeedLeak(result, [diffSeed]);
    expectSeedsQueuedForAnonymization([diffSeed]);
  });

  test("list_properties anonymizes property names", async () => {
    const tool = "list_properties";
    const nameSeed = mkSeed(tool, 0);
    const tx = {
      select: () =>
        chainableRows([
          {
            createdAt: "2026-01-01T00:00:00.000000",
            id: "prop_1",
            name: nameSeed,
            content: { type: "text" },
            status: "active",
          },
        ]),
    };
    const context = buildContext({ tx });

    const response = await DOCUMENT_TOOL_HANDLERS.list_properties({
      args: { matter_id: "ws_1" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [nameSeed]);
    expectSeedsQueuedForAnonymization([nameSeed]);
  });

  // --- matter-tools --------------------------------------------------------

  test("list_tasks (list mode) anonymizes task names", async () => {
    const tool = "list_tasks";
    const nameSeed = mkSeed(tool, 0);
    const tx = {
      select: () =>
        chainableRows([
          {
            createdAt: "2026-01-01T00:00:00.000000",
            id: "task_1",
            name: nameSeed,
            status: "open",
            priority: "high",
            dueDate: null,
          },
        ]),
    };
    const context = buildContext({ tx });

    const response = await MATTER_TOOL_HANDLERS.list_tasks({
      args: { matter_id: "ws_1" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [nameSeed]);
    expectSeedsQueuedForAnonymization([nameSeed]);
  });

  test("list_tasks (detail mode) anonymizes name, location, assignees, and linked entity names", async () => {
    const tool = "list_tasks";
    const nameSeed = mkSeed(tool, 1);
    const locationSeed = mkSeed(tool, 2);
    const assigneeNameSeed = mkSeed(tool, 3);
    const linkedEntityNameSeed = mkSeed(tool, 4);
    const tx = {
      query: {
        entities: {
          findFirst: async () => ({
            id: "task_1",
            workspaceId: "ws_1",
            kind: "task",
            name: nameSeed,
            status: "open",
            priority: "high",
            dueDate: null,
            startAt: null,
            endAt: null,
            location: locationSeed,
            agendaKind: null,
          }),
        },
        taskAssignees: {
          findMany: async () => [
            {
              role: "assignee",
              user: { id: "user_2", name: assigneeNameSeed },
            },
          ],
        },
        entityLinks: {
          findMany: async (input?: {
            where?: { sourceEntityId?: unknown; targetEntityId?: unknown };
          }) =>
            input?.where?.sourceEntityId === undefined
              ? []
              : [
                  {
                    id: "link_1",
                    linkType: "related",
                    sourceEntityId: "task_1",
                    targetEntityId: "doc_1",
                    sourceEntity: {
                      id: "task_1",
                      name: nameSeed,
                      kind: "task",
                    },
                    targetEntity: {
                      id: "doc_1",
                      name: linkedEntityNameSeed,
                      kind: "document",
                    },
                  },
                ],
        },
      },
    };
    const context = buildContext({ tx });

    const response = await MATTER_TOOL_HANDLERS.list_tasks({
      args: { task_id: "task_1" },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [
      nameSeed,
      locationSeed,
      assigneeNameSeed,
      linkedEntityNameSeed,
    ];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  // --- template-tools ------------------------------------------------------

  test("list_templates (list mode) anonymizes name, usage guidance", async () => {
    const tool = "list_templates";
    const nameSeed = mkSeed(tool, 0);
    const whenToUseSeed = mkSeed(tool, 1);
    const whenNotToUseSeed = mkSeed(tool, 2);
    const tx = {
      select: () =>
        chainableRows([
          {
            id: "tpl_1",
            name: nameSeed,
            fieldCount: 2,
            tags: [],
            whenToUse: whenToUseSeed,
            whenNotToUse: whenNotToUseSeed,
          },
        ]),
    };
    const context = buildContext({ tx });

    const response = await TEMPLATE_TOOL_HANDLERS.list_templates({
      args: {},
      context,
    });
    const result = await finalize(context, response);

    const seeds = [nameSeed, whenToUseSeed, whenNotToUseSeed];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  test("list_templates (detail mode) anonymizes template name and field label/hint/aiPrompt", async () => {
    const tool = "list_templates";
    const nameSeed = mkSeed(tool, 3);
    const labelSeed = mkSeed(tool, 4);
    const hintSeed = mkSeed(tool, 5);
    const aiPromptSeed = mkSeed(tool, 6);
    describeStoredTemplateMock.mockResolvedValue({
      name: nameSeed,
      fields: [
        {
          path: "field1",
          label: labelSeed,
          inputType: "text",
          required: false,
          hint: hintSeed,
          options: null,
          formats: null,
          aiPrompt: aiPromptSeed,
          aiAdapt: false,
          optionsFrom: null,
          dateFormat: null,
          parts: null,
          format: null,
        },
      ],
      conditions: [],
      computed: [],
    });
    const context = buildContext();

    const response = await TEMPLATE_TOOL_HANDLERS.list_templates({
      args: { template_id: "tpl_1" },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [nameSeed, labelSeed, hintSeed, aiPromptSeed];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  // --- billing-tools -------------------------------------------------------

  test("list_time_entries (list mode) anonymizes narrative, invoice narrative, and user name", async () => {
    const tool = "list_time_entries";
    const narrativeSeed = mkSeed(tool, 0);
    const invoiceNarrativeSeed = mkSeed(tool, 1);
    const userNameSeed = mkSeed(tool, 2);
    const tx = {
      select: createEntriesAndUserNamesSelect({
        entryRows: [
          {
            id: "te_1",
            entityId: "entity_1",
            userId: "user_2",
            dateWorked: "2026-01-01",
            durationMinutes: 60,
            billedMinutes: 60,
            rateAtEntry: 100,
            currency: "EUR",
            narrative: narrativeSeed,
            invoiceNarrative: invoiceNarrativeSeed,
            billable: true,
            noCharge: false,
            status: "draft",
          },
        ],
        userNameRows: [{ id: "user_2", name: userNameSeed }],
      }),
    };
    const context = buildContext({ tx });

    const response = await BILLING_TOOL_HANDLERS.list_time_entries({
      args: { matter_id: "ws_1" },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [narrativeSeed, invoiceNarrativeSeed, userNameSeed];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  test("list_time_entries (detail mode) anonymizes narrative, invoice narrative, and user name", async () => {
    const tool = "list_time_entries";
    const narrativeSeed = mkSeed(tool, 3);
    const invoiceNarrativeSeed = mkSeed(tool, 4);
    const userNameSeed = mkSeed(tool, 5);
    const tx = {
      query: {
        timeEntries: {
          findFirst: async () => ({ workspaceId: "ws_1" }),
        },
      },
      select: createEntriesAndUserNamesSelect({
        entryRows: [
          {
            id: "te_2",
            entityId: "entity_1",
            userId: "user_3",
            dateWorked: "2026-01-01",
            durationMinutes: 30,
            billedMinutes: 30,
            rateAtEntry: 100,
            currency: "EUR",
            narrative: narrativeSeed,
            invoiceNarrative: invoiceNarrativeSeed,
            billable: true,
            noCharge: false,
            status: "draft",
          },
        ],
        userNameRows: [{ id: "user_3", name: userNameSeed }],
      }),
    };
    const context = buildContext({ tx });

    const response = await BILLING_TOOL_HANDLERS.list_time_entries({
      args: { time_entry_id: "te_2" },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [narrativeSeed, invoiceNarrativeSeed, userNameSeed];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  test("list_invoices (list mode) anonymizes invoice reference", async () => {
    const tool = "list_invoices";
    const referenceSeed = mkSeed(tool, 0);
    const tx = {
      select: () =>
        chainableRows([
          {
            id: "inv_1",
            invoiceNumber: "INV-1",
            reference: referenceSeed,
            status: "draft",
            invoiceDate: "2026-01-01",
            dueDate: "2026-02-01",
            currency: "EUR",
            totalAmount: 1000,
            createdAtCursor: new Date("2026-01-01"),
          },
        ]),
    };
    const context = buildContext({ tx });

    const response = await BILLING_TOOL_HANDLERS.list_invoices({
      args: { matter_id: "ws_1" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [referenceSeed]);
    expectSeedsQueuedForAnonymization([referenceSeed]);
  });

  test("list_invoices (detail mode) anonymizes reference, notes, and nested time-entry/expense fields", async () => {
    const tool = "list_invoices";
    const referenceSeed = mkSeed(tool, 1);
    const notesSeed = mkSeed(tool, 2);
    const teNarrativeSeed = mkSeed(tool, 3);
    const teInvoiceNarrativeSeed = mkSeed(tool, 4);
    const teEntityNameSeed = mkSeed(tool, 5);
    const exDescriptionSeed = mkSeed(tool, 6);
    const exInvoiceDescriptionSeed = mkSeed(tool, 7);
    const exEntityNameSeed = mkSeed(tool, 8);
    const tx = {
      query: {
        invoices: {
          findFirst: async () => ({
            id: "inv_2",
            workspaceId: "ws_1",
            invoiceNumber: "INV-2",
            reference: referenceSeed,
            status: "draft",
            invoiceDate: "2026-01-01",
            dueDate: "2026-02-01",
            currency: "EUR",
            totalAmount: 2000,
            notes: notesSeed,
            paidAt: null,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            timeEntries: [
              {
                id: "te_1",
                matterId: "entity_1",
                dateWorked: "2026-01-01",
                billedMinutes: 60,
                rateAtEntry: 100,
                currency: "EUR",
                narrative: teNarrativeSeed,
                invoiceNarrative: teInvoiceNarrativeSeed,
                status: "invoiced",
                matter: { id: "entity_1", name: teEntityNameSeed },
              },
            ],
            expenses: [
              {
                id: "ex_1",
                matterId: "entity_2",
                dateIncurred: "2026-01-01",
                amount: 100,
                currency: "EUR",
                category: "travel",
                description: exDescriptionSeed,
                invoiceDescription: exInvoiceDescriptionSeed,
                billable: true,
                markup: 0,
                matter: { id: "entity_2", name: exEntityNameSeed },
              },
            ],
          }),
        },
      },
    };
    const context = buildContext({ tx });

    const response = await BILLING_TOOL_HANDLERS.list_invoices({
      args: { invoice_id: "inv_2" },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [
      referenceSeed,
      notesSeed,
      teNarrativeSeed,
      teInvoiceNarrativeSeed,
      teEntityNameSeed,
      exDescriptionSeed,
      exInvoiceDescriptionSeed,
      exEntityNameSeed,
    ];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  // --- knowledge-tools -------------------------------------------------------

  test("list_clauses (list mode) anonymizes clause and category title/description", async () => {
    const tool = "list_clauses";
    const clauseTitleSeed = mkSeed(tool, 0);
    const clauseDescriptionSeed = mkSeed(tool, 1);
    const categoryNameSeed = mkSeed(tool, 2);
    const categoryDescriptionSeed = mkSeed(tool, 3);
    const tx = {
      select: () =>
        chainableRows([
          {
            id: "c1",
            title: clauseTitleSeed,
            categoryId: null,
            language: "en",
            description: clauseDescriptionSeed,
            currentVersion: 1,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
          },
        ]),
      query: {
        clauseCategories: {
          findMany: async () => [
            {
              id: "cat_1",
              parentId: null,
              name: categoryNameSeed,
              description: categoryDescriptionSeed,
              sortOrder: 0,
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            },
          ],
        },
      },
    };
    const context = buildContext({ tx });

    const response = await KNOWLEDGE_TOOL_HANDLERS.list_clauses({
      args: { include_categories: true },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [
      clauseTitleSeed,
      clauseDescriptionSeed,
      categoryNameSeed,
      categoryDescriptionSeed,
    ];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  test("list_clauses (clause detail) anonymizes title, description, usage notes, body, and variants", async () => {
    const tool = "list_clauses";
    const titleSeed = mkSeed(tool, 4);
    const descriptionSeed = mkSeed(tool, 5);
    const usageNotesSeed = mkSeed(tool, 6);
    const bodySeed = mkSeed(tool, 7);
    const variantLabelSeed = mkSeed(tool, 8);
    const variantBodySeed = mkSeed(tool, 9);
    const tx = {
      query: {
        clauses: {
          findFirst: async () => ({
            id: "c2",
            title: titleSeed,
            categoryId: null,
            description: descriptionSeed,
            usageNotes: usageNotesSeed,
            language: "en",
            body: [{ text: bodySeed }],
            metadata: null,
            currentVersion: 1,
            createdBy: "user_1",
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            variants: [
              {
                id: "var_1",
                label: variantLabelSeed,
                body: [{ text: variantBodySeed }],
                sortOrder: 0,
                createdAt: new Date("2026-01-01"),
              },
            ],
            versions: [],
          }),
        },
      },
    };
    const context = buildContext({ tx });

    const response = await KNOWLEDGE_TOOL_HANDLERS.list_clauses({
      args: { clause_id: "c2" },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [
      titleSeed,
      descriptionSeed,
      usageNotesSeed,
      bodySeed,
      variantLabelSeed,
      variantBodySeed,
    ];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  test("list_clauses (version detail) anonymizes the version body", async () => {
    const tool = "list_clauses";
    const versionBodySeed = mkSeed(tool, 10);
    const tx = {
      query: {
        clauses: { findFirst: async () => ({ id: "c2" }) },
        clauseVersions: {
          findFirst: async () => ({
            id: "cv_1",
            version: 1,
            body: [{ text: versionBodySeed }],
            createdAt: new Date("2026-01-01"),
          }),
        },
      },
    };
    const context = buildContext({ tx });

    const response = await KNOWLEDGE_TOOL_HANDLERS.list_clauses({
      args: { clause_id: "c2", version_id: "cv_1" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [versionBodySeed]);
    expectSeedsQueuedForAnonymization([versionBodySeed]);
  });

  // Wave 4 precedent: `readClauseDetail` fails closed when a clause/variant
  // body does not structurally match `ClauseBody` (`isClauseBody`), instead
  // of pushing the raw value through. An empty array fails the `length > 0`
  // check in `isClauseBody`, the smallest input that trips the guard.
  test("list_clauses fails closed (no leak) when a clause body has an unrecognized format", async () => {
    const titleSeed = mkSeed("list_clauses_fail_closed", 0);
    const tx = {
      query: {
        clauses: {
          findFirst: async () => ({
            id: "c3",
            title: titleSeed,
            categoryId: null,
            description: null,
            usageNotes: null,
            language: "en",
            body: [],
            metadata: null,
            currentVersion: 1,
            createdBy: "user_1",
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            variants: [],
            versions: [],
          }),
        },
      },
    };
    const context = buildContext({ tx });

    const response = await KNOWLEDGE_TOOL_HANDLERS.list_clauses({
      args: { clause_id: "c3" },
      context,
    });

    expect(response).toEqual({
      content: [
        { type: "text", text: "Clause body has an unrecognized format" },
      ],
      isError: true,
    });
    // Belt-and-braces: the handler returned a finished error result (never
    // reaching finalizeMcpEgress), so the anonymizer must never have run.
    expect(anonymizeTextFieldsMock.mock.calls.length).toBe(0);
  });

  test("list_playbooks (list mode) anonymizes item name and description", async () => {
    const tool = "list_playbooks";
    const nameSeed = mkSeed(tool, 0);
    const descriptionSeed = mkSeed(tool, 1);
    const tx = {
      select: () =>
        chainableRows([
          {
            id: "pb_1",
            name: nameSeed,
            description: descriptionSeed,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
          },
        ]),
    };
    const context = buildContext({ tx });

    const response = await KNOWLEDGE_TOOL_HANDLERS.list_playbooks({
      args: {},
      context,
    });
    const result = await finalize(context, response);

    const seeds = [nameSeed, descriptionSeed];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });

  test("list_playbooks (detail) anonymizes name, description, and position issue/question/guidance/standard fields", async () => {
    const tool = "list_playbooks";
    const nameSeed = mkSeed(tool, 2);
    const descriptionSeed = mkSeed(tool, 3);
    const issueSeed = mkSeed(tool, 4);
    const questionSeed = mkSeed(tool, 5);
    const guidanceSeed = mkSeed(tool, 6);
    const preferredSeed = mkSeed(tool, 7);
    const fallbackTextSeed = mkSeed(tool, 8);
    const tx = {
      query: {
        playbookDefinitions: {
          findFirst: async () => ({
            id: "pb_2",
            name: nameSeed,
            description: descriptionSeed,
            scope: "organization",
            positions: {
              items: [
                {
                  issue: issueSeed,
                  ask: { question: questionSeed },
                  guidance: guidanceSeed,
                  standard: {
                    source: "inline",
                    preferred: preferredSeed,
                    fallbacks: [{ label: "fallback", text: fallbackTextSeed }],
                  },
                },
              ],
            },
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
          }),
        },
      },
    };
    const context = buildContext({ tx });

    const response = await KNOWLEDGE_TOOL_HANDLERS.list_playbooks({
      args: { playbook_id: "pb_2" },
      context,
    });
    const result = await finalize(context, response);

    const seeds = [
      nameSeed,
      descriptionSeed,
      issueSeed,
      questionSeed,
      guidanceSeed,
      preferredSeed,
      fallbackTextSeed,
    ];
    expectNoSeedLeak(result, seeds);
    expectSeedsQueuedForAnonymization(seeds);
  });
});
