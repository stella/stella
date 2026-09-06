import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { pgFtsProvider } from "@/api/lib/search/pg-fts-provider";
import type { McpRequestContext } from "@/api/mcp/context";
import type { AnonymizingMcpToolName } from "@/api/mcp/static-tool-definitions";
import { isMcpEgressPlan, type McpEgressPlan } from "@/api/mcp/tool-types";
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
 * Each behavior case registers its tool through `canaryTestsFor`; the
 * completeness check compares that exercised set with the live registry in
 * both directions. There is no separate hand-maintained coverage list.
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
  catalogs?: unknown;
  fields: readonly string[];
  organizationId?: unknown;
  workspaceId?: unknown;
};

/** Empty catalogs, one entry per requested id, like the real loaders. */
const emptyCatalogsByWorkspace = async ({
  workspaceIds,
}: {
  workspaceIds: readonly string[];
}) =>
  await Promise.resolve(
    new Map(workspaceIds.map((workspaceId) => [workspaceId, []])),
  );

const anonymizeTextFieldsMock = mock(
  async ({ fields }: AnonymizeTextFieldsInput) => ({
    entityCount: fields.length,
    fields: fields.map((_field, index) => `[ANON_${index}]`),
    redactionMap: new Map<string, string>(),
  }),
);

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

const { finalizeToolEgress } = await import("@/api/mcp/egress");
const { serializeToolResult } = await import("@/api/mcp/tool-utils");
const finalizeMcpEgress = async (
  options: Parameters<typeof finalizeToolEgress>[0],
) =>
  serializeToolResult(
    await finalizeToolEgress(options, {
      anonymizeTextFields: anonymizeTextFieldsMock,
      loadAnonymizationAllowlistCanonicalsByWorkspace: emptyCatalogsByWorkspace,
      loadAnonymizationGazetteerEntriesByWorkspace: emptyCatalogsByWorkspace,
    }),
  );
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

/** The organization `buildContext` scopes a canary run to by default. */
const CANARY_ORGANIZATION_ID = toSafeId<"organization">("org_1");

/**
 * Extracted content reaches the handlers as a real per-org AES-GCM envelope,
 * so a seed is encrypted with the same key the handler decrypts with instead
 * of stubbing the cipher.
 */
const seedExtractedContent = async (seed: string) =>
  await encryptContent(CANARY_ORGANIZATION_ID, seed);

const buildContext = ({
  memberRole = "owner",
  organizationId = CANARY_ORGANIZATION_ID,
  tx = {},
  workspaceIds = ["00000000-0000-4000-8000-0000000a0001"],
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
    accessibleWorkspaces: [],
    grantedScopes: [],
    memberRole,
    organizationId: toSafeId<"organization">(organizationId),
    recordAuditEvent: asTestRaw(mock(async () => undefined)),
    testDependencies: {
      getSearchProvider: () =>
        asTestRaw({ ...pgFtsProvider, search: searchProviderSearchMock }),
      readWorkspaceHandler: readWorkspaceHandlerMock,
      readOverviewHandler: readOverviewHandlerMock,
      readWorkspaceContactsHandler: readWorkspaceContactsHandlerMock,
      readWorkspaceMembersHandler: readWorkspaceMembersHandlerMock,
      describeStoredTemplate: describeStoredTemplateMock,
    },
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

/** Tool names registered by the behavior cases below. */
const CANARY_COVERED_TOOL_NAMES = new Set<string>();

type CanaryTestCase<TToolName extends AnonymizingMcpToolName> = (
  name: string,
  run: (toolName: TToolName) => void | Promise<void>,
) => void;

const canaryTestsFor = <const TToolName extends AnonymizingMcpToolName>(
  toolName: TToolName,
): CanaryTestCase<TToolName> => {
  CANARY_COVERED_TOOL_NAMES.add(toolName);
  return (name, run) =>
    test(name, async () => {
      await run(toolName);
    });
};

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
  });

  // --- compat: search / fetch -------------------------------------------

  const searchCanary = canaryTestsFor("search");

  searchCanary("compat search anonymizes result titles", async (tool) => {
    const titleSeed = mkSeed(tool, 0);
    searchProviderSearchMock.mockResolvedValue({
      hits: [
        {
          entityId: "00000000-0000-4000-8000-0000000e0001",
          workspaceId: "00000000-0000-4000-8000-0000000a0001",
          title: titleSeed,
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
    const tx = {
      select: () =>
        chainableJoinRows([
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            workspaceId: "00000000-0000-4000-8000-0000000a0001",
            fieldId: "field_1",
          },
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

  const fetchCanary = canaryTestsFor("fetch");

  fetchCanary("compat fetch anonymizes title and text", async (tool) => {
    const titleSeed = mkSeed(tool, 0);
    const textSeed = mkSeed(tool, 1);
    const extracted = await seedExtractedContent(textSeed);
    const tx = {
      query: {
        entities: { findFirst: async () => null },
        extractedContent: {
          findFirst: async () => ({
            charCount: textSeed.length,
            ciphertext: extracted.ciphertext,
            iv: extracted.iv,
            entity: {
              name: titleSeed,
              workspaceId: "00000000-0000-4000-8000-0000000a0001",
            },
          }),
        },
      },
    };
    const context = buildContext({ tx });

    const response = await COMPAT_TOOL_HANDLERS.fetch({
      args: { id: "00000000-0000-4000-8000-0000000e0001" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [titleSeed, textSeed]);
    expectSeedsQueuedForAnonymization([titleSeed, textSeed]);
  });

  // --- stella-tools --------------------------------------------------------

  const mattersCanary = canaryTestsFor("list_matters");

  mattersCanary(
    "list_matters (list mode) anonymizes matter names",
    async (tool) => {
      const nameSeed = mkSeed(tool, 0);
      const tx = {
        select: () =>
          chainableRows([
            {
              id: "00000000-0000-4000-8000-0000000a0001",
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
      // The id is the surface's intentional output (callers need the matter id
      // for follow-up tool calls), not a declared text field, so anonymized
      // mode must return it byte-for-byte — unlike `name`/`reference`, which
      // are declared text fields and come back redacted.
      expect(JSON.parse(parseResultText(result))).toEqual({
        matters: [
          {
            id: "00000000-0000-4000-8000-0000000a0001",
            name: "[ANON_0]",
            reference: "[ANON_1]",
            status: "active",
            lastActivityAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    },
  );

  mattersCanary(
    "list_matters (detail mode) anonymizes matter, overview, contacts, and members",
    async (tool) => {
      const matterNameSeed = mkSeed(tool, 1);
      const clientNameSeed = mkSeed(tool, 2);
      const recentNameSeed = mkSeed(tool, 3);
      const createdBySeed = mkSeed(tool, 4);
      const assignedToSeed = mkSeed(tool, 5);
      const contactDisplayNameSeed = mkSeed(tool, 6);
      const memberNameSeed = mkSeed(tool, 7);

      readWorkspaceHandlerMock.mockResolvedValue({
        id: "00000000-0000-4000-8000-0000000a0001",
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
            entityId: "00000000-0000-4000-8000-0000000e0001",
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
            id: "00000000-0000-4000-8000-0000000c0001",
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
        args: { matter_id: "00000000-0000-4000-8000-0000000a0001" },
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
    },
  );

  const crossMatterSearchCanary = canaryTestsFor("search_across_matters");

  crossMatterSearchCanary(
    "search_across_matters anonymizes hit name, headline, and workspace name",
    async (tool) => {
      const nameSeed = mkSeed(tool, 0);
      const headlineSeed = mkSeed(tool, 1);
      const workspaceNameSeed = mkSeed(tool, 2);
      searchProviderSearchMock.mockResolvedValue({
        hits: [
          {
            entityId: "00000000-0000-4000-8000-0000000e0001",
            workspaceId: "00000000-0000-4000-8000-0000000a0001",
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
    },
  );

  const crossMatterReadCanary = canaryTestsFor("read_content_across_matters");

  crossMatterReadCanary(
    "read_content_across_matters anonymizes entity name and text",
    async (tool) => {
      const nameSeed = mkSeed(tool, 0);
      const textSeed = mkSeed(tool, 1);
      const extracted = await seedExtractedContent(textSeed);
      const tx = {
        query: {
          entities: {
            findFirst: async () => ({
              kind: "document",
              name: nameSeed,
              workspaceId: "00000000-0000-4000-8000-0000000a0001",
              extractedContent: {
                sourceEntityVersionId: "ver_current",
                sourceFieldId: "field_current",
                sourceFileId: "file_current",
                sourceSha256Hex: "a".repeat(64),
              },
              currentVersion: {
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                id: "ver_current",
                fields: [
                  {
                    id: "field_current",
                    content: {
                      type: "file",
                      id: "file_current",
                      mimeType: "application/pdf",
                      sha256Hex: "a".repeat(64),
                    },
                  },
                ],
              },
            }),
          },
          extractedContent: {
            findFirst: async () => ({
              ciphertext: extracted.ciphertext,
              extractedAt: new Date("2026-01-02T00:00:00.000Z"),
              iv: extracted.iv,
              sourceEntityVersionId: "ver_current",
              sourceFieldId: "field_current",
              sourceFileId: "file_current",
              sourceSha256Hex: "a".repeat(64),
            }),
          },
          entityVersions: {
            findFirst: async () => ({ id: "ver_current" }),
          },
        },
      };
      const context = buildContext({ tx });

      const response = await STELLA_TOOL_HANDLERS.read_content_across_matters({
        args: { entity_id: "00000000-0000-4000-8000-0000000e0001" },
        context,
      });
      const result = await finalize(context, response);

      expectNoSeedLeak(result, [nameSeed, textSeed]);
      expectSeedsQueuedForAnonymization([nameSeed, textSeed]);
    },
  );

  const contactCanary = canaryTestsFor("read_contact");

  contactCanary(
    "read_contact anonymizes name, org, email, and phone fields",
    async (tool) => {
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
              id: "00000000-0000-4000-8000-0000000c0001",
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
        args: { contact_id: "00000000-0000-4000-8000-0000000c0001" },
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
    },
  );

  // --- document-tools ------------------------------------------------------

  const documentsCanary = canaryTestsFor("list_documents");

  documentsCanary("list_documents anonymizes document names", async (tool) => {
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
      args: { matter_id: "00000000-0000-4000-8000-0000000a0001" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [nameSeed]);
    expectSeedsQueuedForAnonymization([nameSeed]);
  });

  const documentCanary = canaryTestsFor("read_document");

  documentCanary(
    "read_document default/history anonymizes names, fields, and version labels",
    async (tool) => {
      const nameSeed = mkSeed(tool, 0);
      const fieldValueSeed = mkSeed(tool, 1);
      const versionLabelSeed = mkSeed(tool, 3);
      const versionDescriptionSeed = mkSeed(tool, 4);
      const tx = {
        query: {
          entities: {
            findFirst: async () => ({
              createdAt: new Date("2025-12-01T00:00:00.000Z"),
              workspaceId: "00000000-0000-4000-8000-0000000a0001",
              kind: "document",
              name: nameSeed,
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              extractedContent: null,
              // readEntityByIdHandler reads the current version's fields via the
              // `currentVersion` relation (folded into one tombstone-safe query).
              currentVersion: {
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                id: "ver_current",
                fields: [
                  {
                    id: "field_1",
                    propertyId: "prop_1",
                    content: {
                      version: 1,
                      type: "text",
                      value: fieldValueSeed,
                    },
                  },
                ],
              },
              versions: [{ id: "ver_current" }],
            }),
          },
          documentProcessingRuns: { findMany: async () => [] },
          entityVersions: {
            findFirst: async () => ({ id: "ver_current" }),
          },
          extractedContent: { findFirst: async () => null },
          organizationSettings: {
            findFirst: async () => ({ documentProcessingMode: "off" }),
          },
          searchDocuments: {
            findFirst: async () => ({
              updatedAt: new Date("2026-01-02T00:00:00.000Z"),
            }),
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
        args: {
          entity_id: "00000000-0000-4000-8000-0000000e0001",
          include_versions: true,
        },
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
    },
  );

  documentCanary(
    "read_document (specific version) anonymizes that version's field values",
    async (tool) => {
      const versionFieldValueSeed = mkSeed(tool, 2);
      const tx = {
        query: {
          entities: {
            findFirst: async () => ({
              workspaceId: "00000000-0000-4000-8000-0000000a0001",
              kind: "document",
              name: "Doc",
            }),
          },
          entityVersions: {
            // The version_id branch folds the version's fields into the
            // tombstone-checked version query via the `fields` relation.
            findFirst: async () => ({
              id: "00000000-0000-4000-8000-000000030001",
              versionNumber: 1,
              stamp: null,
              label: null,
              description: null,
              createdAt: new Date("2026-01-01"),
              fields: [
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
            }),
          },
        },
      };
      const context = buildContext({ tx });

      const response = await DOCUMENT_TOOL_HANDLERS.read_document({
        args: {
          entity_id: "00000000-0000-4000-8000-0000000e0001",
          version_id: "00000000-0000-4000-8000-000000030001",
        },
        context,
      });
      const result = await finalize(context, response);

      expectNoSeedLeak(result, [versionFieldValueSeed]);
      expectSeedsQueuedForAnonymization([versionFieldValueSeed]);
    },
  );

  // read_document's compare_with_version_id branch diffs two DOCX versions
  // loaded from S3 (loadEntityVersionDocxText -> buildLineDiffSegments).
  // Driving that for real needs an actual DOCX fixture and an S3 double,
  // which this corpus does not attempt (see the file-level blind-spot note).
  // This sub-case is exercised at the egress-plan level instead: the plan
  // shape below mirrors exactly what the diff branch builds
  // (`document-tools.ts`'s `handleReadDocumentTool`, compare branch).
  documentCanary(
    "read_document (diff, egress-plan level) anonymizes diff segment text",
    async (tool) => {
      const diffSeed = mkSeed(tool, 5);
      const diffSegment = { kind: "unchanged" as const, text: diffSeed };
      const payload = {
        entityId: "00000000-0000-4000-8000-0000000e0001",
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
            workspaceId: "00000000-0000-4000-8000-0000000a0001",
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
    },
  );

  const propertiesCanary = canaryTestsFor("list_properties");

  propertiesCanary(
    "list_properties anonymizes property names",
    async (tool) => {
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
        args: { matter_id: "00000000-0000-4000-8000-0000000a0001" },
        context,
      });
      const result = await finalize(context, response);

      expectNoSeedLeak(result, [nameSeed]);
      expectSeedsQueuedForAnonymization([nameSeed]);
    },
  );

  // --- matter-tools --------------------------------------------------------

  const tasksCanary = canaryTestsFor("list_tasks");

  tasksCanary("list_tasks (list mode) anonymizes task names", async (tool) => {
    const nameSeed = mkSeed(tool, 0);
    const tx = {
      select: () =>
        chainableRows([
          {
            createdAt: "2026-01-01T00:00:00.000000",
            id: "00000000-0000-4000-8000-0000000b0001",
            name: nameSeed,
            status: "open",
            priority: "high",
            dueDate: null,
          },
        ]),
    };
    const context = buildContext({ tx });

    const response = await MATTER_TOOL_HANDLERS.list_tasks({
      args: { matter_id: "00000000-0000-4000-8000-0000000a0001" },
      context,
    });
    const result = await finalize(context, response);

    expectNoSeedLeak(result, [nameSeed]);
    expectSeedsQueuedForAnonymization([nameSeed]);
  });

  tasksCanary(
    "list_tasks detail anonymizes names, locations, assignees, and linked entities",
    async (tool) => {
      const nameSeed = mkSeed(tool, 1);
      const locationSeed = mkSeed(tool, 2);
      const assigneeNameSeed = mkSeed(tool, 3);
      const linkedEntityNameSeed = mkSeed(tool, 4);
      const tx = {
        query: {
          entities: {
            findFirst: async () => ({
              id: "00000000-0000-4000-8000-0000000b0001",
              workspaceId: "00000000-0000-4000-8000-0000000a0001",
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
                      sourceEntityId: "00000000-0000-4000-8000-0000000b0001",
                      targetEntityId: "doc_1",
                      sourceEntity: {
                        id: "00000000-0000-4000-8000-0000000b0001",
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
        args: { task_id: "00000000-0000-4000-8000-0000000b0001" },
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
    },
  );

  // --- template-tools ------------------------------------------------------

  const templatesCanary = canaryTestsFor("list_templates");

  templatesCanary(
    "list_templates (list mode) anonymizes name, usage guidance",
    async (tool) => {
      const nameSeed = mkSeed(tool, 0);
      const whenToUseSeed = mkSeed(tool, 1);
      const whenNotToUseSeed = mkSeed(tool, 2);
      const tx = {
        select: () =>
          chainableRows([
            {
              id: "00000000-0000-4000-8000-0000000d0001",
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
    },
  );

  templatesCanary(
    "list_templates detail anonymizes names and field metadata",
    async (tool) => {
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
        args: { template_id: "00000000-0000-4000-8000-0000000d0001" },
        context,
      });
      const result = await finalize(context, response);

      const seeds = [nameSeed, labelSeed, hintSeed, aiPromptSeed];
      expectNoSeedLeak(result, seeds);
      expectSeedsQueuedForAnonymization(seeds);
    },
  );

  // --- billing-tools -------------------------------------------------------

  const timeEntriesCanary = canaryTestsFor("list_time_entries");

  timeEntriesCanary(
    "list_time_entries list anonymizes narratives and user names",
    async (tool) => {
      const narrativeSeed = mkSeed(tool, 0);
      const invoiceNarrativeSeed = mkSeed(tool, 1);
      const userNameSeed = mkSeed(tool, 2);
      const tx = {
        select: createEntriesAndUserNamesSelect({
          entryRows: [
            {
              id: "te_1",
              entityId: "00000000-0000-4000-8000-0000000e0001",
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
        args: { matter_id: "00000000-0000-4000-8000-0000000a0001" },
        context,
      });
      const result = await finalize(context, response);

      const seeds = [narrativeSeed, invoiceNarrativeSeed, userNameSeed];
      expectNoSeedLeak(result, seeds);
      expectSeedsQueuedForAnonymization(seeds);
    },
  );

  timeEntriesCanary(
    "list_time_entries detail anonymizes narratives and user names",
    async (tool) => {
      const narrativeSeed = mkSeed(tool, 3);
      const invoiceNarrativeSeed = mkSeed(tool, 4);
      const userNameSeed = mkSeed(tool, 5);
      const tx = {
        query: {
          timeEntries: {
            findFirst: async () => ({
              workspaceId: "00000000-0000-4000-8000-0000000a0001",
            }),
          },
        },
        select: createEntriesAndUserNamesSelect({
          entryRows: [
            {
              id: "00000000-0000-4000-8000-0000000f0002",
              entityId: "00000000-0000-4000-8000-0000000e0001",
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
        args: { time_entry_id: "00000000-0000-4000-8000-0000000f0002" },
        context,
      });
      const result = await finalize(context, response);

      const seeds = [narrativeSeed, invoiceNarrativeSeed, userNameSeed];
      expectNoSeedLeak(result, seeds);
      expectSeedsQueuedForAnonymization(seeds);
    },
  );

  const invoicesCanary = canaryTestsFor("list_invoices");

  invoicesCanary(
    "list_invoices (list mode) anonymizes invoice reference",
    async (tool) => {
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
        args: { matter_id: "00000000-0000-4000-8000-0000000a0001" },
        context,
      });
      const result = await finalize(context, response);

      expectNoSeedLeak(result, [referenceSeed]);
      expectSeedsQueuedForAnonymization([referenceSeed]);
    },
  );

  invoicesCanary(
    "list_invoices detail anonymizes authored text in nested entries and expenses",
    async (tool) => {
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
              id: "00000000-0000-4000-8000-000000020002",
              workspaceId: "00000000-0000-4000-8000-0000000a0001",
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
                  workItemId: "00000000-0000-4000-8000-0000000e0001",
                  dateWorked: "2026-01-01",
                  billedMinutes: 60,
                  rateAtEntry: 100,
                  currency: "EUR",
                  narrative: teNarrativeSeed,
                  invoiceNarrative: teInvoiceNarrativeSeed,
                  status: "invoiced",
                  workItem: {
                    id: "00000000-0000-4000-8000-0000000e0001",
                    name: teEntityNameSeed,
                  },
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
        args: { invoice_id: "00000000-0000-4000-8000-000000020002" },
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
    },
  );

  // --- knowledge-tools -------------------------------------------------------

  const clausesCanary = canaryTestsFor("list_clauses");

  clausesCanary(
    "list_clauses (list mode) anonymizes clause and category title/description",
    async (tool) => {
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
    },
  );

  clausesCanary(
    "list_clauses detail anonymizes authored clause and variant text",
    async (tool) => {
      const titleSeed = mkSeed(tool, 4);
      const descriptionSeed = mkSeed(tool, 5);
      const usageNotesSeed = mkSeed(tool, 6);
      const bodySeed = mkSeed(tool, 7);
      const variantLabelSeed = mkSeed(tool, 8);
      const variantBodySeed = mkSeed(tool, 9);
      const metadataSeed = mkSeed(tool, 10);
      const tx = {
        query: {
          clauses: {
            findFirst: async () => ({
              id: "00000000-0000-4000-8000-0000000000c2",
              title: titleSeed,
              categoryId: null,
              description: descriptionSeed,
              usageNotes: usageNotesSeed,
              language: "en",
              body: [{ text: bodySeed }],
              metadata: { notes: metadataSeed },
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
        args: { clause_id: "00000000-0000-4000-8000-0000000000c2" },
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
      expectNoSeedLeak(result, [metadataSeed]);
      expectSeedsQueuedForAnonymization(seeds);
    },
  );

  clausesCanary(
    "list_clauses (version detail) anonymizes the version body",
    async (tool) => {
      const versionBodySeed = mkSeed(tool, 10);
      const tx = {
        query: {
          clauses: {
            findFirst: async () => ({
              id: "00000000-0000-4000-8000-0000000000c2",
            }),
          },
          clauseVersions: {
            findFirst: async () => ({
              id: "00000000-0000-4000-8000-000000040001",
              version: 1,
              body: [{ text: versionBodySeed }],
              createdAt: new Date("2026-01-01"),
            }),
          },
        },
      };
      const context = buildContext({ tx });

      const response = await KNOWLEDGE_TOOL_HANDLERS.list_clauses({
        args: {
          clause_id: "00000000-0000-4000-8000-0000000000c2",
          version_id: "00000000-0000-4000-8000-000000040001",
        },
        context,
      });
      const result = await finalize(context, response);

      expectNoSeedLeak(result, [versionBodySeed]);
      expectSeedsQueuedForAnonymization([versionBodySeed]);
    },
  );

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
            id: "00000000-0000-4000-8000-0000000000c3",
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
      args: { clause_id: "00000000-0000-4000-8000-0000000000c3" },
      context,
    });

    if (isMcpEgressPlan(response)) {
      throw new Error("Expected a finished error result, not an egress plan");
    }
    expect(response).toEqual({
      status: "error",
      error: {
        type: "structured",
        code: "validation_error",
        message: "Clause body has an unrecognized format",
        issues: [
          { path: "body", message: "Clause body has an unrecognized format" },
        ],
      },
    });
    // Belt-and-braces: the handler returned a finished error result (never
    // reaching finalizeMcpEgress), so the anonymizer must never have run.
    expect(anonymizeTextFieldsMock.mock.calls.length).toBe(0);
  });

  const playbooksCanary = canaryTestsFor("list_playbooks");

  playbooksCanary(
    "list_playbooks (list mode) anonymizes item name and description",
    async (tool) => {
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
    },
  );

  playbooksCanary(
    "list_playbooks (detail) anonymizes all authored position text",
    async (tool) => {
      const nameSeed = mkSeed(tool, 2);
      const descriptionSeed = mkSeed(tool, 3);
      const issueSeed = mkSeed(tool, 4);
      const questionSeed = mkSeed(tool, 5);
      const guidanceSeed = mkSeed(tool, 6);
      const acceptableRuleSeed = mkSeed(tool, 7);
      const idealSeed = mkSeed(tool, 8);
      const fallbackTextSeed = mkSeed(tool, 9);
      const fallbackLabelSeed = mkSeed(tool, 10);
      const notAcceptableRuleSeed = mkSeed(tool, 11);
      const derivedQuestionSeed = mkSeed(tool, 12);
      const rationaleSeed = mkSeed(tool, 13);
      const talkingPointSeed = mkSeed(tool, 14);
      const escalationSeed = mkSeed(tool, 15);
      const purposeSeed = mkSeed(tool, 16);
      const tx = {
        query: {
          playbookDefinitions: {
            findFirst: async () => ({
              id: "00000000-0000-4000-8000-000000050002",
              name: nameSeed,
              description: descriptionSeed,
              scope: "organization",
              positions: {
                version: 3,
                items: [
                  // Graded, manual ask: exercises the manual question plus every
                  // tier text field (acceptable/not-acceptable rules, inline
                  // ideal language, and each fallback entry's text and label).
                  {
                    mode: "graded",
                    sourceId: "11111111-1111-4111-8111-111111111111",
                    issue: issueSeed,
                    severity: "high",
                    purpose: purposeSeed,
                    guidance: guidanceSeed,
                    negotiation: {
                      rationale: rationaleSeed,
                      talkingPoints: [talkingPointSeed],
                      escalation: escalationSeed,
                    },
                    enabled: true,
                    ask: {
                      mode: "manual",
                      question: questionSeed,
                      content: { type: "text" },
                    },
                    standard: {
                      source: "tiers",
                      tiers: {
                        acceptable: {
                          rules: [
                            {
                              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                              text: acceptableRuleSeed,
                            },
                          ],
                          ideal: { source: "inline", text: idealSeed },
                        },
                        fallback: {
                          entries: [
                            {
                              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                              text: fallbackTextSeed,
                              label: fallbackLabelSeed,
                            },
                          ],
                        },
                        notAcceptable: {
                          rules: [
                            {
                              id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                              text: notAcceptableRuleSeed,
                            },
                          ],
                        },
                      },
                    },
                  },
                  // Graded, auto ask: exercises the derived question redaction.
                  {
                    mode: "graded",
                    sourceId: "22222222-2222-4222-8222-222222222222",
                    issue: "issue-2",
                    severity: "low",
                    enabled: true,
                    ask: {
                      mode: "auto",
                      derived: {
                        question: derivedQuestionSeed,
                        content: { type: "text" },
                        rulesHash: "hash",
                      },
                    },
                    standard: {
                      source: "tiers",
                      tiers: {
                        acceptable: { rules: [] },
                        fallback: { entries: [] },
                        notAcceptable: { rules: [] },
                      },
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
        args: { playbook_id: "00000000-0000-4000-8000-000000050002" },
        context,
      });
      const result = await finalize(context, response);

      const seeds = [
        nameSeed,
        descriptionSeed,
        issueSeed,
        questionSeed,
        guidanceSeed,
        acceptableRuleSeed,
        idealSeed,
        fallbackTextSeed,
        fallbackLabelSeed,
        notAcceptableRuleSeed,
        derivedQuestionSeed,
        rationaleSeed,
        talkingPointSeed,
        escalationSeed,
        purposeSeed,
      ];
      expectNoSeedLeak(result, seeds);
      expectSeedsQueuedForAnonymization(seeds);
    },
  );
});
