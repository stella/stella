import { type InferOk, panic, Result } from "better-result";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import {
  FACET_COUNT_TYPE,
  SEARCH_PAGINATION_COMPLETE,
  countedSearchTotal,
  LEGISLATION_SEARCH_MATCH_TYPES,
  SEARCH_TOTAL_TYPE,
} from "@stll/api-contract/search";
import type { BoeSearchResponse, getLawTextBlock } from "@stll/boe";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import type { ScopedDb } from "@/api/db/safe-db";
import { type contacts, INVOICE_BILLING_PURPOSE } from "@/api/db/schema";
import { env } from "@/api/env";
import type { readGatedDecisionCitationDigest } from "@/api/handlers/case-law/decisions/citation-digest";
import type { readGatedDecisionCitations } from "@/api/handlers/case-law/decisions/citation-passages";
import type { readGatedDecisionWithDocument } from "@/api/handlers/case-law/decisions/get-deferred-document";
import type { lookupDecisionsByIdentity } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { CHAT_READ_SCRIPT_POLICY } from "@/api/handlers/chat/tools/execute/chat-read-script-policy";
import type { readWorkspaceHandler } from "@/api/handlers/workspaces/get";
import type { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import type { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import type { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import type { RegistryLookupResponse } from "@/api/lib/business-registries/dispatch";
import {
  deriveRefMediationEntry,
  projectForChat,
} from "@/api/lib/chat/projection-schema";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { encryptContent } from "@/api/lib/content-encryption";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { SearchResult } from "@/api/lib/search/types";
import type { DescribeTemplateResult } from "@/api/lib/templates/template-fill-service";
import { isRecord } from "@/api/lib/type-guards";
import type { McpRequestContext } from "@/api/mcp/context";
import { LEGISLATION_TOOL_HANDLERS } from "@/api/mcp/legislation-tools";
import type { READ_CONTACT_COLUMNS } from "@/api/mcp/read-contact-columns";
import { STELLA_TOOL_HANDLERS } from "@/api/mcp/stella-tools";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { CASE_LAW_COVERAGE_FIXTURE } from "@/api/tests/helpers/case-law-coverage-fixture";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import type { RegistryReadToolName } from "./ref-field-map";
import { READ_TOOL_REF_FIELD_MAP } from "./ref-field-map";

/**
 * Contract corpus over every chat-projectable read tool: run the real MCP
 * handler through `runRegistryReadTool` against fixtures whose every id-bearing
 * column holds a UUID-formatted value, and require the projection to succeed.
 *
 * This is the structural guard for the bug class behind the prod
 * "Tool output failed anonymization of internal identifiers" failures: the
 * ref-field map is a hand-maintained description of each handler's payload
 * shape, and a handler field the map does not declare only surfaces when a
 * real payload carries a UUID there — at runtime, in prod, failing closed.
 * The canary corpus (`egress-canary.test.ts`) cannot catch this class: its
 * fixtures use non-UUID ids (`ws_1`, `entity_1`), so the UUID backstop never
 * fires there. Here every id is UUID-formatted, so an undeclared field fails
 * this suite instead of production chat.
 *
 * Three guards close the loop:
 * 1. The corpus is keyed by `ProjectableReadToolName` via `satisfies`, so a
 *    read tool marked `chatProjectable: true` without a fixture here fails
 *    typecheck (plus a runtime both-ways check for `bun test` alone).
 * 2. Every call must produce a payload free of undeclared UUIDs and
 *    undeclared fields. At runtime the projection degrades instead of
 *    failing (drops the offending leaf, strips the undeclared key) and
 *    reports a defect; the corpus asserts it returns ok with NO defect
 *    reported, so a fixture that only projects degraded still fails here.
 * 3. Anti-vacuity: per tool, the union of the calls' `expectRefPaths` must
 *    equal the map's declared `outputRefs` paths, and each such path must
 *    resolve to at least one minted chat ref in the actual payload. A fixture
 *    too thin to reach a declared path fails loudly rather than passing
 *    vacuously.
 */

// --- Module mocks (before dynamic imports, canary pattern) -------------------

const readWorkspaceHandlerMock = mock();
const readOverviewHandlerMock = mock();
const readWorkspaceContactsHandlerMock = mock();
const readWorkspaceMembersHandlerMock = mock();
const describeStoredTemplateMock = mock();
const searchProviderSearchMock = mock();
const lookupDecisionsByIdentityMock = mock();
const searchDecisionsHandlerMock = mock();
const readCaseLawCoverageHandlerMock = mock();
const readGatedDecisionWithDocumentMock = mock();
const readGatedDecisionCitationsMock = mock();
const readGatedDecisionCitationDigestMock = mock();
const withRedistributableSubjectMock = mock();
const searchLegislationHandlerMock = mock();
const resolveStatuteExpressionMock = mock();
const resolveStatuteWorkVersionMock = mock();
const readPublicLegislationHandlerMock = mock();
const listStatuteVersionsHandlerMock = mock();
const readProvisionHistoryHandlerMock = mock();
const readLegislationProvisionVersionsMock = mock();
const readVersionBlocksMock = mock();
const searchConsolidatedLegislationMock = mock();
const getLawTextBlockMock = mock();
const executeRegistryLookupMock = mock();

const { buildMcpContextFromChat } = await import("./mcp-chat-context");
const { runRegistryReadTool } = await import("./run-registry-tool");

// --- Fixture ids --------------------------------------------------------------

/** Deterministic, unique, UUID-formatted fixture id. */
const uid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The one accessible workspace every workspace-scoped fixture lives in. */
const WS = uid(1);

/** The organization every fixture context is scoped to. */
const ORGANIZATION_ID = toSafeId<"organization">("org_1");

/**
 * Extracted content is stored as a real per-org AES-GCM envelope, so the
 * fixture is encrypted with the same key the projection decrypts with rather
 * than stubbing the cipher.
 */
const EXTRACTED_TEXT = "decrypted text";
const extractedEnvelope = await encryptContent(ORGANIZATION_ID, EXTRACTED_TEXT);

// --- DB doubles ---------------------------------------------------------------

type ThenableBuilder = {
  from: () => ThenableBuilder;
  where: () => ThenableBuilder;
  orderBy: () => ThenableBuilder;
  groupBy: () => ThenableBuilder;
  innerJoin: () => ThenableBuilder;
  leftJoin: () => ThenableBuilder;
  limit: () => ThenableBuilder;
  then: (
    resolve: (rows: readonly unknown[]) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
};

/**
 * A drizzle-shaped select chain where every step returns the same builder and
 * awaiting it (at any step) resolves to the fixture rows. Covers chains that
 * terminate at `.limit()`, `.where()`, or a join alike, so one double serves
 * every select in the corpus.
 */
const chainable = (rows: readonly unknown[]): ThenableBuilder => {
  const builder: ThenableBuilder = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    groupBy: () => builder,
    innerJoin: () => builder,
    leftJoin: () => builder,
    limit: () => builder,
    // oxlint-disable-next-line unicorn/no-thenable -- drizzle query builders are deliberately thenable, and the double must be awaitable mid-chain the same way
    then: async (resolve, reject) =>
      await Promise.resolve(rows).then(resolve, reject),
  };
  return builder;
};

/**
 * A `tx.select` double that serves one queued row set per select call, in the
 * order the handler issues them. Over- or under-consuming the queue throws so
 * a fixture cannot silently answer the wrong query.
 */
const selectQueue = (queue: readonly (readonly unknown[])[]) => {
  const state = { call: 0 };
  return (): ThenableBuilder => {
    const rows = queue.at(state.call);
    state.call += 1;
    if (rows === undefined) {
      throw new Error(
        `tx.select call #${state.call} has no queued fixture rows (${queue.length} queued)`,
      );
    }
    return chainable(rows);
  };
};

const buildContext = (tx: unknown): McpRequestContext => {
  const scopedDb = asTestRaw<ScopedDb>(
    async (run: (transaction: unknown) => unknown) => await run(tx),
  );
  return buildMcpContextFromChat({
    memberRole: sessionMemberRole("owner"),
    organizationId: ORGANIZATION_ID,
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: [toSafeId<"workspace">(WS)],
      pinnedIds: [],
    }),
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
    testDependencies: {
      // Billing reads are enrolment-gated; this caller is enrolled so every
      // projectable read runs.
      featureAccessSnapshot: enrolledTimeBillingSnapshot({
        organizationId: ORGANIZATION_ID,
        userId: "user_1",
      }),
      readWorkspaceHandler: readWorkspaceHandlerMock,
      readOverviewHandler: readOverviewHandlerMock,
      readWorkspaceContactsHandler: readWorkspaceContactsHandlerMock,
      readWorkspaceMembersHandler: readWorkspaceMembersHandlerMock,
      describeStoredTemplate: describeStoredTemplateMock,
      getSearchReader: () => asTestRaw({ search: searchProviderSearchMock }),
      lookupDecisionsByIdentity: lookupDecisionsByIdentityMock,
      searchDecisionsHandler: searchDecisionsHandlerMock,
      readCaseLawCoverageHandler: readCaseLawCoverageHandlerMock,
      readGatedDecisionWithDocument: readGatedDecisionWithDocumentMock,
      readGatedDecisionCitations: readGatedDecisionCitationsMock,
      readGatedDecisionCitationDigest: readGatedDecisionCitationDigestMock,
      searchLegislationHandler: searchLegislationHandlerMock,
      resolveStatuteExpression: resolveStatuteExpressionMock,
      resolveStatuteWorkVersion: resolveStatuteWorkVersionMock,
      readPublicLegislationHandler: readPublicLegislationHandlerMock,
      listStatuteVersionsHandler: listStatuteVersionsHandlerMock,
      readProvisionHistoryHandler: readProvisionHistoryHandlerMock,
      readLegislationProvisionVersions: readLegislationProvisionVersionsMock,
      readVersionBlocks: readVersionBlocksMock,
      // The corpus gate has its own tests; here a document is reachable.
      resolveAnnotationTarget: async () =>
        await Promise.resolve({
          status: "available" as const,
          readBlocks: async () => await Promise.resolve([]),
        }),
      searchConsolidatedLegislation: searchConsolidatedLegislationMock,
      getLawTextBlock: getLawTextBlockMock,
      executeRegistryLookup: executeRegistryLookupMock,
    },
  });
};

/**
 * The context a call runs with. A `script` read runs as the chat script runner
 * runs it: `buildMcpContextFromChat`, which holds no third-party outbound
 * permit. A `direct-only` read is offered as its direct tool, whose boundary
 * holds one.
 */
const contextFor = (
  toolName: ProjectableReadToolName,
  tx: unknown,
): McpRequestContext =>
  CHAT_READ_SCRIPT_POLICY[toolName] === "script"
    ? buildContext(tx)
    : {
        ...buildContext(tx),
        thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
      };

/**
 * Every fetch the process attempts while `run` is in flight. The fixtures
 * answer every source a read uses, so a read that sends anything reaches past
 * its seams to the network.
 */
const recordOutboundFetches = async <TResult>(
  run: () => Promise<TResult>,
): Promise<{ result: TResult; fetched: readonly string[] }> => {
  const fetched: string[] = [];
  const refuse = Object.assign(
    async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      fetched.push(input instanceof Request ? input.url : String(input));
      return await Promise.reject(
        new Error("A contract fixture read must not reach the network"),
      );
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const spy = spyOn(globalThis, "fetch").mockImplementation(refuse);
  try {
    return { result: await run(), fetched };
  } finally {
    spy.mockRestore();
  }
};

/**
 * One consolidation as the public statute read projects it, with the AST the
 * outline and the plain text are both derived from.
 */
const statuteDocumentFixture = (documentId: string) => ({
  id: documentId,
  eli: "/eli/cz/sb/2012/89",
  slug: "89-2012-sb-obcansky-zakonik",
  title: "89/2012 Sb., občanský zákoník",
  country: "CZE",
  language: "cs",
  documentType: "act",
  status: "in_force",
  effectiveDate: "2014-01-01",
  versionValidFrom: "2014-01-01",
  versionValidTo: null,
  expressionKind: "consolidation" as const,
  windowDisposition: "effective" as const,
  windowDispositionBasis: null,
  sections: null,
  // A GUID-bearing publisher URL: the id belongs to the publisher's own
  // scheme, never a Stella tenant id, so the projection must forward it
  // unchanged rather than treat it as an undeclared internal identifier.
  sourceUrl: `https://example.test/89-2012/${uid(90)}`,
  documentUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  citationCaseCount: 0,
  allowsDerivedAi: true,
  documentAst: {
    blocks: provisionBlocksFixture(),
    metadata: {},
    source: {},
    version: 1,
  },
  fulltext: null,
});

/** A heading plus its paragraph, which is what one provision owns. */
const provisionBlocksFixture = () => [
  {
    anchorId: "par_1729",
    id: "b-1",
    inlines: [],
    level: 3,
    plainText: "§ 1729",
    type: "heading",
  },
  {
    anchorId: "par_1729-odst_1",
    id: "b-2",
    inlines: [],
    plainText: "Snoubenci si zvolí obřad.",
    type: "paragraph",
  },
];

// --- Path + ref assertions ------------------------------------------------------

const CHAT_REF_PATTERN = /^(?:mat|ent|contact|prop)_\d+$/u;

/** Resolve every value an `a.b` / `a[].b` grammar path addresses. */
const readPathValues = (root: unknown, path: string): unknown[] => {
  let cursors: unknown[] = [root];
  for (const token of path.split(".")) {
    const array = token.endsWith("[]");
    const key = array ? token.slice(0, -2) : token;
    const next: unknown[] = [];
    for (const cursor of cursors) {
      if (!isRecord(cursor)) {
        continue;
      }
      const value = cursor[key];
      if (array) {
        if (Array.isArray(value)) {
          next.push(...value);
        }
        continue;
      }
      if (value !== undefined) {
        next.push(value);
      }
    }
    cursors = next;
  }
  return cursors;
};

// --- Corpus -------------------------------------------------------------------

type ContractCall = {
  /** Distinguishes the tool's calls in test titles (list vs detail branch). */
  mode: string;
  buildArgs: (refRegistry: ChatRefRegistry) => Record<string, unknown>;
  /** Fresh per-run `tx` double; omitted for handlers that never touch the DB. */
  tx?: () => unknown;
  /** Arms the module-level mocks this call depends on. */
  setup?: () => void;
  /** Declared outputRef paths this call exercises: each must resolve to ≥1 ref. */
  expectRefPaths: readonly string[];
  /**
   * Literals the projected payload must carry. Pins content the handler has to
   * derive rather than copy (decrypted extracted text), so a fixture that
   * silently stops reaching the real value fails instead of passing vacuously.
   */
  expectPayloadContains?: readonly string[];
};

/**
 * Read tools the chat projection serves, derived from the map's literal
 * `chatProjectable` flags: the corpus below must cover exactly this union, so
 * adding a projectable tool without a contract fixture fails typecheck.
 */
type ProjectableReadToolName = {
  [
    K in RegistryReadToolName
  ]: (typeof READ_TOOL_REF_FIELD_MAP)[K]["chatProjectable"] extends true
    ? K
    : never;
}[RegistryReadToolName];

const matterRef = (refRegistry: ChatRefRegistry): string =>
  refRegistry.toMatterRef(toSafeId<"workspace">(WS));

const entityRef = (refRegistry: ChatRefRegistry, entityId: string): string =>
  refRegistry.toEntityRef({
    entityId: toSafeId<"entity">(entityId),
    workspaceId: toSafeId<"workspace">(WS),
  });

const CONTRACT_CORPUS = {
  list_matters: [
    {
      mode: "list",
      buildArgs: () => ({}),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: WS,
              name: "Acme retainer",
              reference: "REF-1",
              status: "active",
              lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        ]),
      }),
      expectRefPaths: ["matters[].id"],
    },
    {
      mode: "detail",
      buildArgs: (refRegistry) => ({ matter_id: matterRef(refRegistry) }),
      setup: () => {
        readWorkspaceHandlerMock.mockResolvedValue({
          id: toSafeId<"workspace">(WS),
          organizationId: ORGANIZATION_ID,
          name: "Acme retainer",
          reference: "REF-1",
          clientId: toSafeId<"contact">(uid(61)),
          leadUserId: null,
          billingReference: null,
          color: null,
          status: "active",
          lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          client: {
            id: toSafeId<"contact">(uid(61)),
            type: "organization",
            displayName: "Acme s.r.o.",
            color: null,
          },
          stampedVersionCount: 0,
        } satisfies Awaited<ReturnType<typeof readWorkspaceHandler>>);
        readOverviewHandlerMock.mockResolvedValue({
          entityCount: 1,
          documentCount: 1,
          taskCount: 0,
          recentEntities: [
            {
              entityId: toSafeId<"entity">(uid(2)),
              name: "NDA draft.docx",
              kind: "document",
              status: null,
              priority: null,
              listItemType: null,
              dueDate: null,
              mimeType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              // The exact trio that tripped the prod backstop on every
              // non-empty matter: primary-field plumbing ids, now stripped.
              fieldId: uid(3),
              propertyId: uid(4),
              pdfFileId: uid(5),
              encrypted: false,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: null,
              createdBy: "Jana",
              createdByImage: null,
              createdByDeletedAt: null,
              assignedTo: "Petr",
              assignedToImage: null,
              assignedToDeletedAt: null,
            },
          ],
        } satisfies Awaited<ReturnType<typeof readOverviewHandler>>);
        readWorkspaceContactsHandlerMock.mockResolvedValue(
          Result.ok({
            contacts: [
              {
                id: toSafeId<"workspaceContact">(uid(6)),
                organizationId: ORGANIZATION_ID,
                workspaceId: toSafeId<"workspace">(WS),
                contactId: toSafeId<"contact">(uid(7)),
                // Not "client": that relationship lives on `workspaces.clientId`,
                // not a `workspaceContacts` row; "client" is not one of this
                // table's roles.
                role: "co_counsel",
                isPrimary: false,
                notes: null,
                createdAt: new Date("2026-01-01"),
                contact: {
                  id: toSafeId<"contact">(uid(7)),
                  type: "person",
                  displayName: "Jan Novák",
                  color: null,
                },
              },
            ],
            overflow: false,
          } satisfies InferOk<
            Awaited<ReturnType<typeof readWorkspaceContactsHandler>>
          >),
        );
        readWorkspaceMembersHandlerMock.mockResolvedValue([
          {
            id: toSafeId<"workspaceMember">(uid(8)),
            userId: uid(9),
            createdAt: new Date("2026-01-01"),
            user: {
              id: uid(9),
              name: "Member One",
              email: "member@example.test",
              image: null,
            },
          },
        ] satisfies Awaited<ReturnType<typeof readWorkspaceMembersHandler>>);
      },
      expectRefPaths: [
        "matter.id",
        "contacts[].contactId",
        "overview.recentEntities[].entityId",
      ],
    },
  ],
  list_contacts: [
    {
      mode: "list",
      buildArgs: () => ({}),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: uid(10),
              type: "person",
              displayName: "Jan Novák",
              firstName: "Jan",
              lastName: "Novák",
              organizationName: null,
              // Production-shaped jsonb (`contactEmailSchema`): the strict
              // projection parse refuses a thinned stand-in.
              emails: [
                { type: "work", address: "jan@example.test", isPrimary: true },
              ],
              phones: [],
              tags: [],
              color: null,
              createdAt: new Date("2026-01-01"),
              clientMatterCount: 0,
            },
          ],
        ]),
      }),
      expectRefPaths: ["items[].id"],
    },
  ],
  search_across_matters: [
    {
      mode: "search",
      buildArgs: () => ({ query: "nda" }),
      setup: () => {
        searchProviderSearchMock.mockResolvedValue({
          hits: [
            {
              entityId: uid(11),
              workspaceId: WS,
              title: "NDA draft",
              headline: "…the <em>NDA</em>…",
              workspaceName: "Acme retainer",
              kind: "document",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          facets: { kind: [], workspace: [] },
          nextCursor: null,
          totalCount: 1,
        } satisfies SearchResult);
      },
      expectRefPaths: ["hits[].workspaceId", "hits[].entityId"],
    },
  ],
  read_content_across_matters: [
    {
      mode: "read",
      buildArgs: (refRegistry) => ({
        entity_id: entityRef(refRegistry, uid(12)),
      }),
      tx: () => ({
        query: {
          entities: {
            findFirst: async () => ({
              workspaceId: WS,
              kind: "document",
              name: "NDA draft",
              extractedContent: {
                sourceEntityVersionId: uid(60),
                sourceFieldId: uid(61),
                sourceFileId: uid(63),
                sourceSha256Hex: "a".repeat(64),
              },
              currentVersion: {
                id: uid(60),
                createdAt: new Date("2026-01-01"),
                fields: [
                  {
                    id: uid(61),
                    propertyId: uid(62),
                    content: {
                      version: 1,
                      type: "file",
                      id: uid(63),
                      fileName: "NDA draft.pdf",
                      mimeType: "application/pdf",
                      sizeBytes: 12_345,
                      encrypted: false,
                      sha256Hex: "a".repeat(64),
                      pdfFileId: uid(64),
                    },
                  },
                ],
              },
            }),
          },
          entityVersions: {
            findFirst: async () => ({ id: uid(60) }),
          },
          extractedContent: {
            findFirst: async () => ({
              charCount: EXTRACTED_TEXT.length,
              ciphertext: extractedEnvelope.ciphertext,
              extractedAt: new Date("2026-01-02"),
              iv: extractedEnvelope.iv,
              sourceEntityVersionId: uid(60),
              sourceFieldId: uid(61),
              sourceFileId: uid(63),
              sourceSha256Hex: "a".repeat(64),
              entity: { kind: "document", name: "NDA draft", workspaceId: WS },
            }),
          },
        },
      }),
      expectRefPaths: ["workspaceId", "entityId"],
      // Reached only by really decrypting the fixture envelope above.
      expectPayloadContains: [EXTRACTED_TEXT],
    },
  ],
  read_contact: [
    {
      mode: "read",
      buildArgs: (refRegistry) => ({
        contact_id: refRegistry.toContactRef(toSafeId<"contact">(uid(13))),
      }),
      tx: () => ({
        query: {
          contacts: {
            findFirst: async () =>
              ({
                id: toSafeId<"contact">(uid(13)),
                type: "person",
                displayName: "Jan Novák",
                firstName: "Jan",
                lastName: "Novák",
                organizationName: null,
                // Production-shaped jsonb (`contactEmailSchema`/
                // `contactPhoneSchema`): the strict projection parse refuses a
                // thinned stand-in.
                emails: [
                  {
                    type: "work",
                    address: "jan@example.test",
                    isPrimary: true,
                  },
                ],
                phones: [
                  { type: "mobile", number: "+420123456789", isPrimary: true },
                ],
                dateOfBirthYear: null,
                dateOfBirthMonth: null,
                dateOfBirthDay: null,
                nationalityCodes: [],
              }) satisfies Pick<
                typeof contacts.$inferSelect,
                keyof typeof READ_CONTACT_COLUMNS
              >,
          },
        },
      }),
      expectRefPaths: ["contactId"],
    },
  ],
  list_documents: [
    {
      mode: "list",
      buildArgs: (refRegistry) => ({ matter_id: matterRef(refRegistry) }),
      tx: () => ({
        select: selectQueue([
          [
            {
              createdAt: new Date("2026-01-01"),
              id: uid(14),
              name: "NDA draft.docx",
              kind: "document",
              parentId: uid(15),
            },
          ],
        ]),
      }),
      expectRefPaths: ["documents[].id", "documents[].parentId"],
    },
  ],
  read_document: [
    {
      mode: "default with versions",
      buildArgs: (refRegistry) => ({
        entity_id: entityRef(refRegistry, uid(16)),
        include_versions: true,
      }),
      tx: () => ({
        query: {
          entities: {
            findFirst: async () => ({
              createdAt: new Date("2025-12-01"),
              workspaceId: WS,
              kind: "document",
              name: "NDA draft",
              updatedAt: new Date("2026-01-01"),
              extractedContent: {
                extractedAt: new Date("2026-01-01"),
                sourceEntityVersionId: uid(17),
                sourceFieldId: uid(61),
                sourceFileId: uid(63),
                sourceSha256Hex: "a".repeat(64),
              },
              currentVersion: {
                id: uid(17),
                createdAt: new Date("2026-01-01"),
                fields: [
                  {
                    id: uid(18),
                    propertyId: uid(19),
                    content: { version: 1, type: "text", value: "Body text" },
                  },
                  {
                    // Every uploaded document carries a file field whose
                    // content embeds storage UUIDs; a text-only fixture let
                    // exactly that slip past this corpus into prod.
                    id: uid(61),
                    propertyId: uid(62),
                    content: {
                      version: 1,
                      type: "file",
                      id: uid(63),
                      fileName: "NDA draft.pdf",
                      mimeType: "application/pdf",
                      sizeBytes: 12_345,
                      encrypted: false,
                      sha256Hex: "a".repeat(64),
                      pdfFileId: uid(64),
                    },
                  },
                ],
              },
              versions: [{ id: uid(17) }],
            }),
          },
          documentProcessingRuns: { findMany: async () => [] },
          entityVersions: {
            findFirst: async () => ({ id: uid(17) }),
          },
          extractedContent: {
            findFirst: async () => ({
              charCount: 0,
              extractedAt: new Date("2026-01-01"),
              sourceEntityVersionId: uid(17),
              sourceFieldId: uid(61),
              sourceFileId: uid(63),
              sourceSha256Hex: "a".repeat(64),
            }),
          },
          organizationSettings: {
            findFirst: async () => ({ documentProcessingMode: "off" }),
          },
          searchDocuments: { findFirst: async () => undefined },
        },
        select: selectQueue([
          [
            {
              id: uid(20),
              versionNumber: 2,
              stamp: null,
              label: "v2",
              description: "Second round",
              createdAt: new Date("2026-01-01"),
            },
          ],
        ]),
      }),
      expectRefPaths: ["entityId", "fields[].propertyId"],
    },
    {
      mode: "specific version",
      buildArgs: (refRegistry) => ({
        entity_id: entityRef(refRegistry, uid(16)),
        version_id: uid(21),
      }),
      tx: () => ({
        query: {
          entities: {
            findFirst: async () => ({
              workspaceId: WS,
              kind: "document",
              name: "NDA draft",
            }),
          },
          entityVersions: {
            findFirst: async () => ({
              id: uid(21),
              versionNumber: 1,
              stamp: null,
              label: null,
              description: null,
              createdAt: new Date("2026-01-01"),
              fields: [
                {
                  id: uid(22),
                  propertyId: uid(23),
                  content: { version: 1, type: "text", value: "Old body" },
                },
                {
                  id: uid(65),
                  propertyId: uid(66),
                  content: {
                    version: 1,
                    type: "file",
                    id: uid(67),
                    fileName: "Old draft.docx",
                    mimeType:
                      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    sizeBytes: 9876,
                    encrypted: false,
                    sha256Hex: "b".repeat(64),
                    pdfFileId: uid(68),
                  },
                },
              ],
            }),
          },
        },
      }),
      expectRefPaths: ["version.fields[].propertyId"],
    },
  ],
  list_properties: [
    {
      mode: "list",
      buildArgs: (refRegistry) => ({ matter_id: matterRef(refRegistry) }),
      tx: () => ({
        select: selectQueue([
          [
            {
              createdAt: new Date("2026-01-01"),
              id: uid(24),
              name: "Counterparty",
              content: { type: "text" },
              status: "active",
            },
          ],
        ]),
      }),
      expectRefPaths: ["properties[].id"],
    },
  ],
  list_tasks: [
    {
      mode: "list",
      buildArgs: (refRegistry) => ({ matter_id: matterRef(refRegistry) }),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: uid(25),
              name: "File the brief",
              status: "open",
              priority: "high",
              itemType: null,
              dueDate: null,
              matterId: WS,
              matterName: "Acme v. Beta",
              matterReference: "2026-001",
            },
          ],
        ]),
      }),
      expectRefPaths: ["tasks[].id", "tasks[].matterId"],
    },
    {
      mode: "detail",
      buildArgs: (refRegistry) => ({
        task_id: entityRef(refRegistry, uid(26)),
      }),
      tx: () => ({
        query: {
          entities: {
            findFirst: async () => ({
              id: uid(26),
              workspaceId: WS,
              kind: "task",
              name: "File the brief",
              status: "open",
              priority: "high",
              dueDate: null,
              startAt: null,
              endAt: null,
              location: "Prague",
              agendaKind: null,
            }),
          },
          taskAssignees: {
            findMany: async () => [
              { role: "assignee", user: { id: uid(27), name: "Member One" } },
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
                      id: uid(28),
                      linkType: "related",
                      sourceEntityId: uid(26),
                      targetEntityId: uid(29),
                      sourceEntity: {
                        id: uid(26),
                        name: "File the brief",
                        kind: "task",
                      },
                      targetEntity: {
                        id: uid(29),
                        name: "NDA draft",
                        kind: "document",
                      },
                    },
                  ],
          },
        },
      }),
      expectRefPaths: ["task.taskId", "task.links[].entity.id"],
    },
  ],
  list_clauses: [
    {
      mode: "list with categories",
      buildArgs: () => ({ include_categories: true }),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: uid(30),
              title: "Confidentiality",
              categoryId: uid(31),
              language: "en",
              description: "Standard NDA clause",
              currentVersion: 1,
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            },
          ],
        ]),
        query: {
          clauseCategories: {
            findMany: async () => [
              {
                id: uid(31),
                parentId: uid(32),
                name: "NDA",
                description: "Non-disclosure",
                sortOrder: 0,
                createdAt: new Date("2026-01-01"),
                updatedAt: new Date("2026-01-01"),
              },
            ],
          },
        },
      }),
      expectRefPaths: [],
    },
    {
      mode: "detail",
      buildArgs: () => ({ clause_id: uid(30) }),
      tx: () => ({
        $count: async () => 0,
        query: {
          clauses: {
            findFirst: async () => ({
              id: uid(30),
              title: "Confidentiality",
              categoryId: uid(31),
              description: "Standard NDA clause",
              usageNotes: "Use for mutual NDAs",
              language: "en",
              body: [{ text: "The parties shall keep confidential…" }],
              metadata: null,
              currentVersion: 1,
              createdBy: uid(34),
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
              variants: [
                {
                  id: uid(33),
                  label: "One-way",
                  body: [{ text: "The receiving party shall…" }],
                  sortOrder: 0,
                  createdAt: new Date("2026-01-01"),
                },
              ],
              versions: [],
            }),
          },
        },
      }),
      expectRefPaths: [],
    },
  ],
  list_playbooks: [
    {
      mode: "list",
      buildArgs: () => ({}),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: uid(35),
              name: "NDA review",
              description: "Mutual NDA playbook",
              // Selected by the list handler; drift the hand list never
              // surfaced (the strict parse requires every declared field).
              status: "draft",
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            },
          ],
        ]),
      }),
      expectRefPaths: [],
    },
    {
      mode: "detail",
      buildArgs: () => ({ playbook_id: uid(35) }),
      tx: () => ({
        query: {
          playbookDefinitions: {
            findFirst: async () => ({
              id: uid(35),
              name: "NDA review",
              description: "Mutual NDA playbook",
              // `scope` is a nullable `PlaybookScope` jsonb object
              // (`playbookScopeSchema`), not a string; the previous
              // string stand-in could never occur in production.
              scope: { perspective: "buyer" },
              // Selected by the detail handler; drift the hand list never
              // surfaced (the strict parse requires every declared field).
              status: "draft",
              positions: {
                version: 3,
                items: [
                  {
                    mode: "graded",
                    sourceId: uid(36),
                    issue: "Confidentiality term",
                    severity: "high",
                    purpose: "Bounds how long the recipient stays bound",
                    guidance: "Cap at 3 years",
                    // One source the caller's lookup returns and one it
                    // does not: only the first may reach the model, as refs.
                    sources: [
                      { workspaceId: WS, entityId: uid(105) },
                      { workspaceId: uid(106), entityId: uid(107) },
                    ],
                    enabled: true,
                    ask: {
                      mode: "manual",
                      question: "How long is the term?",
                      content: { version: 1, type: "text" },
                    },
                    standard: {
                      source: "tiers",
                      tiers: {
                        acceptable: {
                          rules: [{ id: uid(37), text: "Max 3 years" }],
                          // Exercises the ideal clause link the hand list
                          // never declared (it licensed a stale pre-v2
                          // `standard.clauseId` path instead); the backstop
                          // verifies the schema licenses this handle.
                          ideal: { source: "clause", clauseId: uid(70) },
                        },
                        fallback: {
                          entries: [
                            { id: uid(38), text: "5 years", label: "Fallback" },
                          ],
                        },
                        notAcceptable: {
                          rules: [{ id: uid(39), text: "Indefinite" }],
                        },
                      },
                    },
                  },
                  {
                    mode: "graded",
                    sourceId: uid(99),
                    issue: "Liability cap",
                    severity: "high",
                    enabled: true,
                    ask: { mode: "auto" },
                    standard: {
                      source: "reference",
                      termKind: "parameter",
                      passages: [
                        {
                          id: uid(100),
                          workspaceId: uid(101),
                          entityId: uid(102),
                          fileFieldId: uid(103),
                          entityVersionId: uid(104),
                          blockId: "block-1",
                        },
                      ],
                    },
                  },
                ],
              },
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            }),
          },
        },
        // The scoped source lookup (`readablePositionSources`).
        select: selectQueue([
          [
            {
              entityId: uid(105),
              workspaceId: WS,
              name: "Supply agreement.docx",
              workspaceName: "Supply matter",
            },
          ],
        ]),
      }),
      expectRefPaths: [
        "playbook.positions.items[].sources[].workspaceId",
        "playbook.positions.items[].sources[].entityId",
      ],
    },
  ],
  list_time_entries: [
    {
      mode: "list",
      buildArgs: (refRegistry) => ({ matter_id: matterRef(refRegistry) }),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: uid(40),
              activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
              entityId: uid(41),
              entityReference: { type: "available", id: uid(41) },
              userId: uid(42),
              dateWorked: "2026-01-01",
              durationMinutes: 60,
              billedMinutes: 60,
              rateAtEntry: 100,
              currency: "EUR",
              narrative: "Drafted the NDA",
              narrativeLanguage: null,
              invoiceNarrative: null,
              billable: true,
              noCharge: false,
              status: "draft",
            },
          ],
          [{ id: uid(42), name: "Member One" }],
        ]),
      }),
      expectRefPaths: ["entries[].entityId", "entries[].entityReference.id"],
    },
    {
      mode: "list",
      buildArgs: (refRegistry) => ({ matter_id: matterRef(refRegistry) }),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: uid(44),
              activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
              entityId: null,
              entityReference: null,
              userId: null,
              dateWorked: "2026-01-02",
              durationMinutes: 30,
              billedMinutes: 30,
              rateAtEntry: 0,
              currency: "XXX",
              narrative: "Unassigned non-billable work",
              narrativeLanguage: null,
              invoiceNarrative: null,
              billable: false,
              noCharge: false,
              status: "draft",
            },
          ],
          [],
        ]),
      }),
      expectRefPaths: [],
    },
    {
      mode: "detail",
      buildArgs: () => ({ time_entry_id: uid(40) }),
      tx: () => ({
        query: {
          timeEntries: { findFirst: async () => ({ workspaceId: WS }) },
        },
        select: selectQueue([
          [
            {
              id: uid(40),
              activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
              entityId: uid(41),
              entityReference: { type: "available", id: uid(41) },
              userId: uid(42),
              dateWorked: "2026-01-01",
              durationMinutes: 60,
              billedMinutes: 60,
              rateAtEntry: 100,
              currency: "EUR",
              narrative: "Drafted the NDA",
              narrativeLanguage: null,
              invoiceNarrative: null,
              billable: true,
              noCharge: false,
              status: "draft",
            },
          ],
          [{ id: uid(42), name: "Member One" }],
        ]),
      }),
      expectRefPaths: [
        "entry.entityId",
        "entry.entityReference.id",
        "entry.workspaceId",
      ],
    },
  ],
  list_invoices: [
    {
      mode: "list",
      buildArgs: (refRegistry) => ({ matter_id: matterRef(refRegistry) }),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: uid(45),
              invoiceNumber: "INV-1",
              documentType: "invoice",
              originalInvoiceId: null,
              reference: "Acme January",
              status: "draft",
              invoiceDate: "2026-01-01",
              dueDate: "2026-02-01",
              currency: "EUR",
              totalAmount: 1000,
              createdAtCursor: new Date("2026-01-01"),
            },
          ],
        ]),
      }),
      expectRefPaths: [],
    },
    {
      mode: "detail",
      buildArgs: () => ({ invoice_id: uid(46) }),
      tx: () => ({
        query: {
          invoices: {
            findFirst: async () => ({
              id: uid(46),
              workspaceId: WS,
              invoiceNumber: "INV-2",
              documentType: "invoice",
              originalInvoiceId: null,
              reference: "Acme February",
              status: "draft",
              invoiceDate: "2026-02-01",
              taxableSupplyDate: "2026-02-01",
              dueDate: "2026-03-01",
              currency: "EUR",
              totalAmount: 2000,
              netAmount: 100,
              vatAmount: 21,
              notes: "Net 30",
              sellerProfileId: uid(106),
              buyerName: "Acme s.r.o.",
              buyerRegistrationId: "12345678",
              buyerVatId: "CZ12345678",
              buyerAddressLine1: "Hlavni 1",
              buyerAddressLine2: null,
              buyerCity: "Praha",
              buyerPostalCode: "110 00",
              buyerCountry: "CZ",
              paidAt: null,
              createdAt: new Date("2026-02-01"),
              updatedAt: new Date("2026-02-01"),
              timeEntries: [
                {
                  id: uid(47),
                  workItemId: uid(48),
                  workItemReference: { type: "available", id: uid(48) },
                  dateWorked: "2026-02-01",
                  billedMinutes: 60,
                  rateAtEntry: 100,
                  currency: "EUR",
                  narrative: "Drafted the NDA",
                  narrativeLanguage: null,
                  invoiceNarrative: null,
                  noCharge: false,
                  status: "invoiced",
                  workItem: { id: uid(48), name: "NDA draft" },
                },
              ],
              expenses: [
                {
                  id: uid(49),
                  matterId: uid(50),
                  matterReference: { type: "available", id: uid(50) },
                  dateIncurred: "2026-02-01",
                  amount: 100,
                  currency: "EUR",
                  category: "travel",
                  description: "Court filing fee",
                  invoiceDescription: null,
                  billable: true,
                  markup: 0,
                  matter: { id: uid(50), name: "Filing bundle" },
                },
              ],
              lines: [
                {
                  id: uid(105),
                  position: 0,
                  description: "Drafted the NDA",
                  quantity: "1.0000",
                  unit: "h",
                  unitPrice: 100,
                  vatRateBps: 2100,
                  vatTreatment: "domestic_vat",
                  netAmount: 100,
                  vatAmount: 21,
                  grossAmount: 121,
                  source: "time_entry",
                  billingPurpose: INVOICE_BILLING_PURPOSE.ORDINARY,
                  timeEntryId: uid(47),
                  expenseId: null,
                  releasedAt: null,
                },
              ],
            }),
          },
        },
      }),
      expectRefPaths: [
        "invoice.workspaceId",
        "invoice.timeEntries[].entityId",
        "invoice.timeEntries[].entityReference.id",
        "invoice.timeEntries[].entity.id",
        "invoice.expenses[].entityId",
        "invoice.expenses[].entityReference.id",
        "invoice.expenses[].entity.id",
      ],
    },
  ],
  get_usage: [
    {
      mode: "read",
      buildArgs: () => ({}),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: uid(51),
              status: "active",
              seats: 3,
              source: "polar",
              currentPeriodStart: new Date("2026-01-01"),
              currentPeriodEnd: new Date("2026-02-01"),
              cancelAtPeriodEnd: false,
              policyId: uid(52),
              policyKey: "pro",
              policyDisplayName: "Pro",
              policyMonthlyUsageUnits: 1000,
            },
          ],
          [{ total: 3000 }],
          [{ total: 1200 }],
        ]),
      }),
      expectRefPaths: [],
    },
  ],
  case_law_coverage: [
    {
      mode: "search",
      buildArgs: () => ({}),
      setup: () => {
        readCaseLawCoverageHandlerMock.mockResolvedValue(
          CASE_LAW_COVERAGE_FIXTURE,
        );
      },
      expectRefPaths: [],
    },
  ],
  search_case_law: [
    {
      mode: "search",
      buildArgs: () => ({ country: "CZE", queries: ["dobré mravy"] }),
      setup: () => {
        searchDecisionsHandlerMock.mockResolvedValue({
          paginationOutcome: SEARCH_PAGINATION_COMPLETE,
          facets: null,
          hits: [
            {
              anchorId: null,
              caseNumber: "22 Cdo 1000/2020",
              caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
              citationAuthority: 1.4,
              citationCount: 3,
              country: "CZ",
              court: "Nejvyšší soud",
              courtAbbreviation: "NS",
              courtTier: "supreme",
              createdAt: "2020-05-01T00:00:00.000Z",
              decisionDate: "2020-05-01",
              decisionId: uid(53),
              decisionType: "judgment",
              ecli: "ECLI:CZ:NS:2020:22.CDO.1000.2020.1",
              identifiers: [
                {
                  type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
                  value: "22 Cdo 1000/2020",
                },
                {
                  type: DECISION_IDENTIFIER_TYPES.ECLI,
                  value: "ECLI:CZ:NS:2020:22.CDO.1000.2020.1",
                },
              ],
              headline: "…dobré <em>mravy</em>…",
              language: "cs",
              textWithheldReason: null,
              matchingPassages: 3,
              headnote: { type: "absent", reason: "not_published" },
              keywords: null,
              languageAlternates: [],
              slug: "ns-22-cdo-1000-2020",
              // GUID-bearing publisher URL; see the statute fixture above.
              sourceUrl: `https://example.test/decision/${uid(91)}`,
            },
          ],
          nextCursor: null,
          total: countedSearchTotal(SEARCH_TOTAL_TYPE.EXACT, 1),
          queryUsed: "dobré mravy",
          warnings: [],
        } satisfies Awaited<ReturnType<typeof searchDecisionsHandler>>);
      },
      expectRefPaths: [],
    },
    {
      // Page one of a single query carries the filter rail. A source facet's
      // value is the source's own id, which an agent passes back as
      // `source_id`; a null-facets fixture alone never exercised it.
      mode: "search",
      buildArgs: () => ({ country: "CZE", queries: ["dobré mravy"] }),
      setup: () => {
        searchDecisionsHandlerMock.mockResolvedValue({
          paginationOutcome: SEARCH_PAGINATION_COMPLETE,
          facets: {
            courtYear: null,
            court: [
              {
                tierLabel: "supreme",
                courts: [{ value: "Nejvyšší soud", label: null, count: 1 }],
              },
            ],
            year: [{ value: "2020", label: null, count: 1 }],
            decisionType: [{ value: "judgment", label: null, count: 1 }],
            source: [
              {
                value: uid(108),
                label: "Nejvyšší soud",
                count: 1,
                countType: FACET_COUNT_TYPE.EXACT,
              },
            ],
            language: [{ value: "cs", label: null, count: 1 }],
          },
          hits: [
            {
              anchorId: null,
              caseNumber: "22 Cdo 1000/2020",
              caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
              citationAuthority: 1.4,
              citationCount: 3,
              country: "CZ",
              court: "Nejvyšší soud",
              courtAbbreviation: "NS",
              courtTier: "supreme",
              createdAt: "2020-05-01T00:00:00.000Z",
              decisionDate: "2020-05-01",
              decisionId: uid(53),
              decisionType: "judgment",
              ecli: "ECLI:CZ:NS:2020:22.CDO.1000.2020.1",
              identifiers: [
                {
                  type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
                  value: "22 Cdo 1000/2020",
                },
                {
                  type: DECISION_IDENTIFIER_TYPES.ECLI,
                  value: "ECLI:CZ:NS:2020:22.CDO.1000.2020.1",
                },
              ],
              headline: "…dobré <em>mravy</em>…",
              language: "cs",
              textWithheldReason: null,
              matchingPassages: 3,
              headnote: { type: "absent", reason: "not_published" },
              keywords: null,
              languageAlternates: [],
              slug: "ns-22-cdo-1000-2020",
              // GUID-bearing publisher URL; see the statute fixture above.
              sourceUrl: `https://example.test/decision/${uid(91)}`,
            },
          ],
          nextCursor: null,
          total: countedSearchTotal(SEARCH_TOTAL_TYPE.EXACT, 1),
          queryUsed: "dobré mravy",
          warnings: [],
        } satisfies Awaited<ReturnType<typeof searchDecisionsHandler>>);
      },
      expectRefPaths: [],
    },
  ],
  lookup_case_law: [
    {
      mode: "search",
      buildArgs: () => ({
        country: "CZE",
        identifiers: ["22 Cdo 1000/2020"],
      }),
      setup: () => {
        // The identity read, not the ranked search: this tool resolves a
        // reference off the identity columns and never consults a provider.
        lookupDecisionsByIdentityMock.mockResolvedValue([
          {
            caseNumber: "22 Cdo 1000/2020",
            caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
            country: "CZ",
            court: "Nejvyšší soud",
            courtAbbreviation: "NS",
            decisionDate: "2020-05-01",
            ecli: "ECLI:CZ:NS:2020:22.CDO.1000.2020.1",
            id: toSafeId<"caseLawDecision">(uid(53)),
            identifiers: [
              {
                type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
                value: "22 Cdo 1000/2020",
              },
            ],
            language: "cs",
            languageAlternates: [],
            slug: "ns-22-cdo-1000-2020",
          },
        ] satisfies Awaited<ReturnType<typeof lookupDecisionsByIdentity>>);
      },
      expectRefPaths: [],
    },
  ],
  read_case_law_decision: [
    {
      mode: "read",
      buildArgs: () => ({ decision_ids: [uid(54)] }),
      setup: () => {
        readGatedDecisionWithDocumentMock.mockResolvedValue({
          hasDocument: true,
          documentPending: false,
          documentReadFailed: false,
          documentUnavailable: false,
          id: toSafeId<"caseLawDecision">(uid(54)),
          resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
          caseNumber: "22 Cdo 1000/2020",
          caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          citationsFrom: [
            {
              id: toSafeId<"caseLawCitation">(uid(55)),
              citationText: "21 Cdo 500/2019",
              citedDecisionId: toSafeId<"caseLawDecision">(uid(56)),
              sectionIndex: 0,
            },
          ],
          citationsTo: [
            {
              id: toSafeId<"caseLawCitation">(uid(57)),
              citationText: "23 Cdo 200/2021",
              citingDecisionId: toSafeId<"caseLawDecision">(uid(58)),
              sectionIndex: 1,
            },
          ],
          citationsNextCursor: null,
          country: "CZ",
          court: "Nejvyšší soud",
          courtAbbreviation: "NS",
          courtTier: "supreme",
          // `decisionDate` is a plain `date`-mode column (a "YYYY-MM-DD"
          // string), not a `Date` object.
          decisionDate: "2020-05-01",
          decisionType: "judgment",
          documentAst: null,
          documentAstSource: null,
          projectionDigest: null,
          // GUID-bearing publisher URL; see the statute fixture above.
          documentUrl: `https://example.test/decision/${uid(92)}`,
          ecli: "ECLI:CZ:NS:2020:22.CDO.1000.2020.1",
          identifiers: [
            {
              type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
              value: "22 Cdo 1000/2020",
            },
            {
              type: DECISION_IDENTIFIER_TYPES.ECLI,
              value: "ECLI:CZ:NS:2020:22.CDO.1000.2020.1",
            },
          ],
          fulltext: "Full decision text.",
          judges: [],
          headnote: { type: "absent", reason: "not_published" },
          sections: null,
          language: "cs",
          languageGroupKey: null,
          languageAlternates: [],
          metadata: {},
          textFields: {
            abstract: { type: "absent", reason: "not_published" },
            headnote: { type: "absent", reason: "not_published" },
            legalSentence: { type: "absent", reason: "not_published" },
            summary: { type: "absent", reason: "not_published" },
          },
          slug: "ns-22-cdo-1000-2020",
          source: {
            id: toSafeId<"caseLawSource">(uid(59)),
            name: "NS ČR",
            adapterKey: "cz-ns",
            allowsDerivedAi: true,
          },
          // GUID-bearing publisher URLs; see the statute fixture above.
          sourceUrl: `https://example.test/decision/${uid(93)}`,
          sourceAttributionUrl: `https://example.test/decision/${uid(94)}`,
          createdAt: new Date("2020-05-01T00:00:00.000Z"),
          updatedAt: new Date("2020-05-01T00:00:00.000Z"),
        } satisfies Awaited<ReturnType<typeof readGatedDecisionWithDocument>>);
        // The summary names decisions at both ends: a citing one by name and
        // link, a cited one the corpus holds by its decision id, and one it
        // does not hold by its text.
        const relatedDecision = (n: number, caseNumber: string) => ({
          id: toSafeId<"caseLawDecision">(uid(n)),
          caseNumber,
          caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          citationAuthority: 1.5,
          country: "CZ",
          court: "Nejvyšší soud",
          decisionDate: "2021-03-04",
          decisionType: "judgment",
          ecli: null,
          language: "cs",
          languageAlternates: [],
          slug: `ns-${String(n)}`,
        });
        const noCitations = {
          negative: 0,
          neutral: 0,
          positive: 0,
          supportive: 0,
          mixed: 0,
          unclassified: 0,
        };
        readGatedDecisionCitationDigestMock.mockResolvedValue({
          summary: {
            incoming: { ...noCitations, positive: 1, unclassified: 49 },
            outgoing: { ...noCitations, neutral: 2 },
            capped: { incoming: false, outgoing: false },
            incomingByYear: [],
          },
          topCiting: [relatedDecision(58, "23 Cdo 200/2021")],
          cites: [
            {
              id: toSafeId<"caseLawCitation">(uid(55)),
              citationText: "21 Cdo 500/2019",
              textWithheldReason: null,
              sectionIndex: 0,
              treatment: "neutral",
              decision: relatedDecision(56, "21 Cdo 500/2019"),
            },
            {
              id: toSafeId<"caseLawCitation">(uid(60)),
              citationText: "sp. zn. 20 Cdo 1/2001",
              textWithheldReason: null,
              sectionIndex: 1,
              treatment: "neutral",
              decision: null,
            },
          ],
          citesMore: true,
        } satisfies Awaited<
          ReturnType<typeof readGatedDecisionCitationDigest>
        >);
      },
      expectRefPaths: [],
    },
  ],
  read_case_law_citations: [
    {
      mode: "read",
      buildArgs: () => ({ decision_id: uid(54), direction: "cited_by" }),
      setup: () => {
        readGatedDecisionCitationsMock.mockResolvedValue({
          type: "page",
          page: {
            items: [
              {
                id: toSafeId<"caseLawCitation">(uid(57)),
                citationText: "22 Cdo 1000/2020",
                textWithheldReason: null,
                sectionIndex: 1,
                treatment: "positive",
                decision: {
                  id: toSafeId<"caseLawDecision">(uid(58)),
                  caseNumber: "23 Cdo 200/2021",
                  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
                  citationAuthority: 2.5,
                  country: "CZ",
                  court: "Nejvyšší soud",
                  decisionDate: "2021-03-04",
                  decisionType: "judgment",
                  ecli: "ECLI:CZ:NS:2021:23.CDO.200.2021.1",
                  language: "cs",
                  languageAlternates: [],
                  slug: "ns-23-cdo-200-2021",
                },
                passage: {
                  anchorId: "b12",
                  text: "Soud odkázal na rozsudek 22 Cdo 1000/2020.",
                  truncated: false,
                  mention: "sole",
                },
              },
            ],
            nextCursor: null,
          },
        } satisfies Awaited<ReturnType<typeof readGatedDecisionCitations>>);
      },
      expectRefPaths: [],
    },
  ],
  search_legislation: LEGISLATION_SEARCH_MATCH_TYPES.map((matchType) => ({
    mode: `search-${matchType}`,
    buildArgs: () => ({ country: "CZE", query: "náhrada škody" }),
    setup: () => {
      searchLegislationHandlerMock.mockResolvedValue({
        paginationOutcome: SEARCH_PAGINATION_COMPLETE,
        items: [
          {
            documentId: uid(70),
            eli: "/eli/cz/sb/2012/89",
            title: "89/2012 Sb., občanský zákoník",
            country: "CZE",
            language: "cs",
            match: { type: matchType },
            documentType: "act",
            status: "in_force",
            effectiveDate: "2014-01-01",
            // GUID-bearing publisher URL; see the statute fixture above.
            sourceUrl: `https://example.test/89-2012/${uid(95)}`,
            headline: "<mark>náhrada škody</mark>",
            score: 1.5,
          },
        ],
        nextCursor: null,
        total: { type: SEARCH_TOTAL_TYPE.NOT_COUNTED },
      });
    },
    expectRefPaths: [],
    expectPayloadContains: [
      JSON.stringify({ match: { type: matchType } }).slice(1, -1),
    ],
  })),
  read_statute: [
    {
      mode: "read",
      buildArgs: () => ({ eli: "/eli/cz/sb/2012/89" }),
      setup: () => {
        resolveStatuteExpressionMock.mockResolvedValue({
          type: "expression",
          id: toSafeId<"legislationDocument">(uid(71)),
        });
        readPublicLegislationHandlerMock.mockResolvedValue(
          statuteDocumentFixture(uid(71)),
        );
        listStatuteVersionsHandlerMock.mockResolvedValue({
          items: [
            {
              id: uid(71),
              versionValidFrom: "2014-01-01",
              versionValidTo: null,
              expressionKind: "consolidation" as const,
              windowDisposition: "effective" as const,
              windowDispositionBasis: null,
            },
          ],
          nextCursor: null,
        });
      },
      expectRefPaths: [],
    },
  ],
  read_statute_provisions: [
    {
      mode: "batch",
      buildArgs: () => ({
        items: [{ anchor: "par_1729", eli: "/eli/cz/sb/2012/89" }],
      }),
      setup: () => {
        resolveStatuteExpressionMock.mockResolvedValue({
          type: "expression",
          id: toSafeId<"legislationDocument">(uid(72)),
        });
        readLegislationProvisionVersionsMock.mockResolvedValue([
          {
            id: toSafeId<"legislationDocument">(uid(72)),
            astS3Key: null,
            documentAst: null,
            versionValidFrom: "2014-01-01",
            versionValidTo: null,
            expressionKind: "consolidation" as const,
            windowDisposition: "effective" as const,
            windowDispositionBasis: null,
            country: "CZE",
            slug: "89-2012-sb-obcansky-zakonik",
            sourceUrl: "https://www.e-sbirka.cz/sb/2012/89",
            allowsDerivedAi: true,
          },
        ]);
        readVersionBlocksMock.mockResolvedValue(provisionBlocksFixture());
      },
      expectRefPaths: [],
    },
  ],
  read_provision_history: [
    {
      mode: "history",
      buildArgs: () => ({ anchor: "par_1729", eli: "/eli/cz/sb/2012/89" }),
      setup: () => {
        resolveStatuteWorkVersionMock.mockResolvedValue({
          type: "expression",
          id: toSafeId<"legislationDocument">(uid(73)),
        });
        readProvisionHistoryHandlerMock.mockResolvedValue({
          items: [
            {
              country: "CZE",
              slug: "89-2012-sb-obcansky-zakonik",
              sourceUrl: "https://www.e-sbirka.cz/sb/2012/89",
              allowsDerivedAi: true,
              documentId: uid(73),
              versionValidFrom: "2014-01-01",
              versionValidTo: null,
              expressionKind: "consolidation" as const,
              windowDisposition: "effective" as const,
              windowDispositionBasis: null,
              text: "§ 1729\nSnoubenci...",
            },
          ],
          nextCursor: null,
        });
      },
      expectRefPaths: [],
    },
  ],
  search_boe_legislation: [
    {
      expectPayloadContains: [
        JSON.stringify({ url: `https://boe.es/consolidado/${uid(98)}` }).slice(
          1,
          -1,
        ),
      ],
      mode: "search",
      buildArgs: () => ({ query: "impuesto" }),
      setup: () => {
        searchConsolidatedLegislationMock.mockResolvedValue({
          data: [
            {
              identificador: "BOE-A-2020-1",
              titulo: "Ley 1/2020",
              // GUID-bearing publisher URLs; see the statute fixture above.
              url_eli: `https://boe.es/eli/${uid(97)}`,
              url_html_consolidada: `https://boe.es/consolidado/${uid(98)}`,
            },
          ],
          status: { code: "200", text: "ok" },
        } satisfies BoeSearchResponse);
      },
      expectRefPaths: [],
    },
    {
      mode: "block",
      buildArgs: () => ({ law_id: "BOE-A-2020-1", block_id: "a1" }),
      setup: () => {
        getLawTextBlockMock.mockResolvedValue(
          "<bloque>Artículo 1</bloque>" satisfies Awaited<
            ReturnType<typeof getLawTextBlock>
          >,
        );
      },
      expectRefPaths: [],
    },
  ],
  lookup_business_registry: [
    {
      mode: "lookup",
      buildArgs: () => ({ registry: "ares", query: "27074358" }),
      tx: () => ({
        query: {
          organizationSettings: {
            findFirst: async () => ({
              practiceJurisdictions: [],
              nativeToolOverrides: { ares: true },
            }),
          },
        },
      }),
      setup: () => {
        executeRegistryLookupMock.mockResolvedValue({
          type: "lookup",
          registry: "ares",
          hit: {
            registry: "ares",
            id: "27074358",
            name: "Acme s.r.o.",
            legalForm: "s.r.o.",
            // `address` is a structured `BusinessRegistryAddress`, not a
            // free-form string.
            address: {
              line1: null,
              line2: null,
              postalCode: null,
              city: null,
              region: null,
              country: null,
              textAddress: "Praha 1",
            },
            // GUID-bearing publisher URL; see the statute fixture above.
            registryUrl: `https://ares.gov.cz/27074358/${uid(96)}`,
          },
        } satisfies RegistryLookupResponse);
      },
      expectRefPaths: [],
    },
  ],
  list_templates: [
    {
      mode: "list",
      buildArgs: () => ({}),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: uid(60),
              name: "Engagement letter",
              fieldCount: 2,
              tags: [],
              whenToUse: "New client intake",
              whenNotToUse: "Existing engagements",
            },
          ],
        ]),
      }),
      expectRefPaths: [],
    },
    {
      mode: "detail",
      buildArgs: () => ({ template_id: uid(60) }),
      setup: () => {
        describeStoredTemplateMock.mockResolvedValue({
          name: "Engagement letter",
          fields: [
            {
              path: "client_name",
              visibleWhen: null,
              label: "Client name",
              inputType: "text",
              required: true,
              hint: null,
              options: null,
              lookup: null,
              validation: null,
              source: null,
              aiSeesDocument: false,
              aiPrompt: null,
              aiAdapt: false,
              optionsFrom: null,
              dateFormat: null,
            },
          ],
          conditions: [],
          computed: [],
          arrays: [],
          warnings: [],
        } satisfies DescribeTemplateResult);
      },
      expectRefPaths: [],
    },
  ],
  list_reader_annotations: [
    {
      mode: "a mark over two paragraphs",
      buildArgs: () => ({ target_type: "decision", target_id: uid(60) }),
      tx: () => ({
        select: selectQueue([
          [
            ["p-3", "The court held"],
            ["p-4", "that the claim was time-barred"],
          ].map(([blockAnchorId, quote], index) => ({
            id: uid(61 + index),
            groupId: uid(63),
            kind: "comment",
            visibility: "shared",
            color: null,
            style: null,
            blockAnchorId,
            startOffset: 0,
            endOffset: 10,
            quote,
            body: index === 0 ? "Check the limitation date" : null,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
            authorId: uid(64),
            authorName: "Reader",
            authorImage: null,
            mine: true,
            createdAtCursor: "2026-01-01T00:00:00.000000Z",
          })),
        ]),
      }),
      expectRefPaths: [],
      expectPayloadContains: ["Check the limitation date", "p-4"],
    },
  ],
} as const satisfies Record<ProjectableReadToolName, readonly ContractCall[]>;

/**
 * Recover the key type `Object.entries` widens to string. Honest by
 * construction: the corpus is a closed literal whose keys `satisfies` pins to
 * exactly `ProjectableReadToolName`.
 */
const isCorpusToolName = (name: string): name is ProjectableReadToolName =>
  name in CONTRACT_CORPUS;

const corpusEntries = (): readonly (readonly [
  ProjectableReadToolName,
  readonly ContractCall[],
])[] =>
  Object.keys(CONTRACT_CORPUS).flatMap((name) =>
    isCorpusToolName(name) ? [[name, CONTRACT_CORPUS[name]] as const] : [],
  );

// --- Suite --------------------------------------------------------------------

const ALL_MOCKS = [
  readWorkspaceHandlerMock,
  readOverviewHandlerMock,
  readWorkspaceContactsHandlerMock,
  readWorkspaceMembersHandlerMock,
  describeStoredTemplateMock,
  searchProviderSearchMock,
  lookupDecisionsByIdentityMock,
  searchDecisionsHandlerMock,
  readCaseLawCoverageHandlerMock,
  readGatedDecisionWithDocumentMock,
  readGatedDecisionCitationsMock,
  readGatedDecisionCitationDigestMock,
  searchLegislationHandlerMock,
  resolveStatuteExpressionMock,
  resolveStatuteWorkVersionMock,
  readPublicLegislationHandlerMock,
  listStatuteVersionsHandlerMock,
  readProvisionHistoryHandlerMock,
  readLegislationProvisionVersionsMock,
  readVersionBlocksMock,
  searchConsolidatedLegislationMock,
  getLawTextBlockMock,
  executeRegistryLookupMock,
];

// A projection refusal reports the offending path through the real capture
// path; the recorded events turn a failing call into a diagnosable one.
// The per-call tests are generated inside a loop, so they reach the recorder
// through these module-scope helpers rather than closing over the binding.
let analytics: RecordingAnalytics | null = null;

const recordedExceptions = () =>
  (analytics ?? panic("recording analytics is not installed")).exceptions();

// Production serves the public-law pages, so every corpus result carries an
// `appUrl`; a decision or statute without a slug is addressed by its id there.
let previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;

afterEach(() => {
  analytics?.restore();
  analytics = null;
  env.FEATURE_PUBLIC_LAW = previousFeaturePublicLaw;
});

beforeEach(() => {
  analytics = installRecordingAnalytics();
  previousFeaturePublicLaw = env.FEATURE_PUBLIC_LAW;
  env.FEATURE_PUBLIC_LAW = true;
  for (const handlerMock of ALL_MOCKS) {
    handlerMock.mockReset();
  }
  withRedistributableSubjectMock.mockReset();
  // The gate's own behaviour is covered by `public-subject.db.test.ts`; here
  // it stands in as "this id passed the gate" so the projection is reachable
  // without a database.
  withRedistributableSubjectMock.mockImplementation(
    async (
      _db: unknown,
      locator: { kind: "id"; id: string },
      read: (subject: { id: string }) => Promise<unknown>,
    ) => await read({ id: locator.id }),
  );
});

describe("registry projection contract", () => {
  for (const toolName of ["search_case_law", "search_legislation"] as const) {
    test(`${toolName} projects the publisher as primary when the deployment cannot serve the item`, async () => {
      const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      const previous = env.FEATURE_PUBLIC_LAW;
      env.FEATURE_PUBLIC_LAW = false;
      try {
        const call =
          corpusEntries()
            .find(([name]) => name === toolName)?.[1]
            .at(0) ?? panic("Missing citation fixture");
        call.setup?.();
        const refRegistry = createChatRefRegistry();
        const args = call.buildArgs(refRegistry);
        const handler =
          toolName === "search_case_law"
            ? STELLA_TOOL_HANDLERS.search_case_law
            : LEGISLATION_TOOL_HANDLERS.search_legislation;
        // The advertised registry hides disabled tools. Exercise the handler's
        // shared output projection directly to reach its deployment fallback.
        const response = await handler({
          args,
          context: contextFor(toolName, {}),
        });
        if (!("status" in response) || response.status !== "success") {
          panic("Citation handler failed");
        }
        const result = projectForChat({
          payload: response.data,
          schema: READ_TOOL_REF_FIELD_MAP[toolName].projection,
          refRegistry,
          dehydration: {
            args,
            resolvedMatterParams: {},
            resolvedEntityParams: {},
            dehydratedEntityRefs: new Map(),
          },
          source: "run-registry-tool",
          toolName,
        });
        if (Result.isError(result)) {
          panic("Citation projection failed", result.error);
        }
        const payload = result.value;
        if (!isRecord(payload) || !Array.isArray(payload["results"])) {
          panic("No citation search results");
        }
        expect(payload["results"].length).toBeGreaterThan(0);
        for (const item of payload["results"]) {
          if (!isRecord(item)) {
            panic("Invalid citation result");
          }
          expect(item["appUrl"]).toBeNull();
          expect(item["url"]).toBe(item["sourceUrl"]);
          expect(item["url"]).toMatch(/^https:/u);
          expect(item["source_url"]).toBeUndefined();
        }
      } finally {
        env.FEATURE_PUBLIC_LAW = previous;
        restore();
      }
    });
  }

  test("every declared outputRef path is exercised by some fixture call", () => {
    for (const [toolName, calls] of corpusEntries()) {
      // Derived from the entry's projection schema, the only artifact.
      const lists = deriveRefMediationEntry(
        READ_TOOL_REF_FIELD_MAP[toolName].projection,
      );
      const declared = lists.outputRefs.map((field) => field.path).toSorted();
      const exercised = [
        ...new Set(calls.flatMap((call) => call.expectRefPaths)),
      ].toSorted();
      expect(
        exercised,
        `${toolName}: the corpus' expectRefPaths must equal the map's ` +
          "declared outputRefs paths — an unexercised declaration is a " +
          "vacuous fixture, an undeclared expectation is a stale test",
      ).toEqual(declared);
    }
  });

  for (const [toolName, calls] of corpusEntries()) {
    for (const call of calls) {
      test(`${toolName} (${call.mode}) projects with no undeclared UUID`, async () => {
        call.setup?.();
        const refRegistry = createChatRefRegistry();
        const context = contextFor(toolName, call.tx?.() ?? {});

        const { result, fetched } = await recordOutboundFetches(
          async () =>
            await runRegistryReadTool({
              args: call.buildArgs(refRegistry),
              context,
              refRegistry,
              toolName,
            }),
        );
        expect(
          fetched,
          `${toolName} (${call.mode}): the read sent a request past its seams`,
        ).toEqual([]);

        if (Result.isError(result)) {
          const leakPaths = recordedExceptions()
            .map((event) => event.properties["path"])
            .filter((path): path is string => typeof path === "string");
          const leakSuffix =
            leakPaths.length > 0
              ? ` — undeclared UUID at: ${leakPaths.join(", ")}`
              : "";
          throw new Error(
            `${toolName} (${call.mode}) failed: ${result.error.message}${leakSuffix}`,
          );
        }

        const payload = result.value;
        const assertCitationLinks = (value: unknown) => {
          if (Array.isArray(value)) {
            for (const item of value) {
              assertCitationLinks(item);
            }
            return;
          }
          if (typeof value !== "object" || value === null) {
            return;
          }
          if ("appUrl" in value) {
            expect(
              "url" in value,
              `${toolName}: every reader link has a primary url`,
            ).toBe(true);
            if ("url" in value && typeof value.appUrl === "string") {
              expect(value.url).toBe(value.appUrl);
              if ("sourceUrl" in value && typeof value.sourceUrl === "string") {
                expect("source_url" in value && value.source_url).toBe(
                  new URL(value.sourceUrl).href,
                );
              }
            }
          }
          for (const child of Object.values(value)) {
            assertCitationLinks(child);
          }
        };
        assertCitationLinks(payload);
        if (call.expectPayloadContains) {
          const serialized = JSON.stringify(payload);
          for (const literal of call.expectPayloadContains) {
            expect(
              serialized,
              `${toolName} (${call.mode}): expected "${literal}" in the ` +
                "projected payload",
            ).toContain(literal);
          }
        }
        for (const path of call.expectRefPaths) {
          const values = readPathValues(payload, path);
          expect(
            values.length,
            `${toolName} (${call.mode}): declared outputRef path "${path}" ` +
              "resolved to nothing — the fixture never exercised it",
          ).toBeGreaterThan(0);
          for (const value of values) {
            expect(
              value,
              `${toolName} (${call.mode}): "${path}" must hold a chat ref`,
            ).toMatch(CHAT_REF_PATTERN);
          }
        }

        // Declared strip paths must be gone from the projected payload — not
        // merely tolerated by the backstop. This stays meaningful even if a
        // path were ever declared as both strip and passthrough, where a
        // broken strip would otherwise survive the ok result.
        for (const path of deriveRefMediationEntry(
          READ_TOOL_REF_FIELD_MAP[toolName].projection,
        ).stripPaths) {
          expect(
            readPathValues(payload, path).length,
            `${toolName} (${call.mode}): declared stripPath "${path}" must ` +
              "be absent from the projected payload",
          ).toBe(0);
        }

        // A clean projection reports nothing: no refusal or defect hides
        // behind a payload that merely looks well formed. This is the guard
        // on the runtime degrade: a stripped undeclared field or a dropped
        // unmappable id succeeds at runtime but reports a defect, which
        // fails the corpus here (its `defect` and `paths` name the leak).
        expect(
          recordedExceptions().map((event) => ({
            class: event.properties["error.class"],
            defect: event.properties["defect"],
            paths: event.properties["paths"],
          })),
          `${toolName} (${call.mode}): the call reported an exception`,
        ).toEqual([]);
      });
    }
  }
});

describe("third-party outbound permit", () => {
  for (const [toolName, calls] of corpusEntries()) {
    if (CHAT_READ_SCRIPT_POLICY[toolName] === "script") {
      continue;
    }
    for (const call of calls) {
      test(`${toolName} (${call.mode}) refuses the chat context and sends nothing`, async () => {
        call.setup?.();
        const refRegistry = createChatRefRegistry();

        const { result, fetched } = await recordOutboundFetches(
          async () =>
            await runRegistryReadTool({
              args: call.buildArgs(refRegistry),
              context: buildContext(call.tx?.() ?? {}),
              refRegistry,
              toolName,
            }),
        );

        expect(Result.isError(result)).toBe(true);
        expect(fetched).toEqual([]);
        for (const handlerMock of ALL_MOCKS) {
          expect(handlerMock).not.toHaveBeenCalled();
        }
      });
    }
  }
});

describe("decision text in chat projection", () => {
  test("decision read preserves its text through the chat projection", async () => {
    const text = "[23] Žaloba se zamítá. Náklady řízení nese žalobce.";
    readGatedDecisionWithDocumentMock.mockResolvedValue({
      hasDocument: true,
      documentPending: false,
      documentReadFailed: false,
      documentUnavailable: false,
      id: toSafeId<"caseLawDecision">(uid(54)),
      resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
      caseNumber: "22 Cdo 1000/2020",
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      citationsFrom: [],
      citationsTo: [],
      citationsNextCursor: null,
      country: "CZ",
      court: "Nejvyšší soud",
      courtAbbreviation: "NS",
      courtTier: "supreme",
      decisionDate: "2020-05-01",
      decisionType: "judgment",
      documentAst: null,
      documentAstSource: null,
      projectionDigest: null,
      documentUrl: "https://example.test/decision/document",
      ecli: "ECLI:CZ:NS:2020:22.CDO.1000.2020.1",
      identifiers: [
        {
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          value: "22 Cdo 1000/2020",
        },
        {
          type: DECISION_IDENTIFIER_TYPES.ECLI,
          value: "ECLI:CZ:NS:2020:22.CDO.1000.2020.1",
        },
      ],
      fulltext: text,
      judges: [],
      headnote: { type: "absent", reason: "not_published" },
      sections: null,
      language: "cs",
      languageGroupKey: null,
      languageAlternates: [],
      metadata: {},
      textFields: {
        abstract: { type: "absent", reason: "not_published" },
        headnote: { type: "absent", reason: "not_published" },
        legalSentence: { type: "absent", reason: "not_published" },
        summary: { type: "absent", reason: "not_published" },
      },
      slug: "ns-22-cdo-1000-2020",
      source: {
        id: toSafeId<"caseLawSource">(uid(59)),
        name: "NS ČR",
        adapterKey: "cz-ns",
        allowsDerivedAi: true,
      },
      sourceUrl: "https://example.test/decision/source",
      sourceAttributionUrl: "https://example.test/decision/attribution",
      createdAt: new Date("2020-05-01T00:00:00.000Z"),
      updatedAt: new Date("2020-05-01T00:00:00.000Z"),
    } satisfies Awaited<ReturnType<typeof readGatedDecisionWithDocument>>);
    const noCitations = {
      negative: 0,
      neutral: 0,
      positive: 0,
      supportive: 0,
      mixed: 0,
      unclassified: 0,
    };
    readGatedDecisionCitationDigestMock.mockResolvedValue({
      summary: {
        incoming: noCitations,
        outgoing: noCitations,
        capped: { incoming: false, outgoing: false },
        incomingByYear: [],
      },
      topCiting: [],
      cites: [],
      citesMore: false,
    } satisfies Awaited<ReturnType<typeof readGatedDecisionCitationDigest>>);
    const toolName = "read_case_law_decision";
    const refRegistry = createChatRefRegistry();
    const { result, fetched } = await recordOutboundFetches(async () =>
      runRegistryReadTool({
        args: { decision_ids: [uid(54)] },
        context: contextFor(toolName, {}),
        refRegistry,
        toolName,
      }),
    );
    expect(fetched).toEqual([]);
    if (Result.isError(result)) {
      panic("Decision read projection failed", result.error);
    }
    expect(readPathValues(result.value, "items[].decision.text")).toEqual([
      text,
    ]);
    const queryResult = await runRegistryReadTool({
      args: { decision_ids: [uid(54)], query: "Žaloba" },
      context: contextFor(toolName, {}),
      refRegistry,
      toolName,
    });
    if (Result.isError(queryResult)) {
      panic("Decision query projection failed", queryResult.error);
    }
    expect(
      readPathValues(queryResult.value, "items[].decision.textSource"),
    ).toEqual(["fulltext"]);
    expect(
      readPathValues(
        queryResult.value,
        "items[].decision.matches.paragraphs[].position",
      ),
    ).toEqual([1]);
    expect(
      readPathValues(
        queryResult.value,
        "items[].decision.matches.paragraphs[].label",
      ),
    ).toEqual(["23"]);
    expect(
      readPathValues(
        queryResult.value,
        "items[].decision.matches.paragraphs[].headingPath",
      ),
    ).toEqual([[]]);
    expect(recordedExceptions()).toEqual([]);
  });
});
