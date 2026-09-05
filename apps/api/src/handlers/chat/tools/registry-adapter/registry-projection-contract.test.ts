import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { BoeSearchResponse, getLawTextBlock } from "@stll/boe";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { ScopedDb } from "@/api/db/safe-db";
import type { readGatedDecisionWithDocument } from "@/api/handlers/case-law/decisions/get-deferred-document";
import type { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import type { readWorkspaceHandler } from "@/api/handlers/workspaces/get";
import type { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import type { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import type { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import { toSafeId } from "@/api/lib/branded-types";
import type { RegistryLookupResponse } from "@/api/lib/business-registries/dispatch";
import { deriveRefMediationEntry } from "@/api/lib/chat/projection-schema";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { encryptContent } from "@/api/lib/content-encryption";
import type { SearchResult } from "@/api/lib/search/types";
import type { DescribeTemplateResult } from "@/api/lib/templates/template-fill-service";
import type { McpRequestContext } from "@/api/mcp/context";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
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
 * 2. Every call must produce a payload free of undeclared UUIDs — this is
 *    `runRegistryReadTool`'s own fail-closed backstop; the corpus asserts it
 *    returns ok instead of the anonymization failure.
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
const searchDecisionsHandlerMock = mock();
const readGatedDecisionWithDocumentMock = mock();
const withRedistributableSubjectMock = mock();
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    // eslint-disable-next-line unicorn/no-thenable -- drizzle query builders are deliberately thenable, and the double must be awaitable mid-chain the same way
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
    memberRole: "owner",
    organizationId: ORGANIZATION_ID,
    safeDb: toSafeDbMock(scopedDb),
    scopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: [toSafeId<"workspace">(WS)],
      pinnedIds: [],
    }),
    userId: toSafeId<"user">("user_1"),
    testDependencies: {
      readWorkspaceHandler: readWorkspaceHandlerMock,
      readOverviewHandler: readOverviewHandlerMock,
      readWorkspaceContactsHandler: readWorkspaceContactsHandlerMock,
      readWorkspaceMembersHandler: readWorkspaceMembersHandlerMock,
      describeStoredTemplate: describeStoredTemplateMock,
      getSearchProvider: () => asTestRaw({ search: searchProviderSearchMock }),
      searchDecisionsHandler: searchDecisionsHandlerMock,
      readGatedDecisionWithDocument: readGatedDecisionWithDocumentMock,
      searchConsolidatedLegislation: searchConsolidatedLegislationMock,
      getLawTextBlock: getLawTextBlockMock,
      executeRegistryLookup: executeRegistryLookupMock,
    },
  });
};

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
  [K in RegistryReadToolName]: (typeof READ_TOOL_REF_FIELD_MAP)[K]["chatProjectable"] extends true
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
        readWorkspaceContactsHandlerMock.mockResolvedValue([
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
        ] satisfies Awaited<ReturnType<typeof readWorkspaceContactsHandler>>);
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
            findFirst: async () => ({
              id: uid(13),
              type: "person",
              displayName: "Jan Novák",
              firstName: "Jan",
              lastName: "Novák",
              organizationName: null,
              // Production-shaped jsonb (`contactEmailSchema`/
              // `contactPhoneSchema`): the strict projection parse refuses a
              // thinned stand-in.
              emails: [
                { type: "work", address: "jan@example.test", isPrimary: true },
              ],
              phones: [
                { type: "mobile", number: "+420123456789", isPrimary: true },
              ],
            }),
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
              createdAt: new Date("2026-01-01"),
              id: uid(25),
              name: "File the brief",
              status: "open",
              priority: "high",
              dueDate: null,
            },
          ],
        ]),
      }),
      expectRefPaths: ["tasks[].id"],
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
                    guidance: "Cap at 3 years",
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
                ],
              },
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            }),
          },
        },
      }),
      expectRefPaths: [],
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
              entityId: uid(41),
              userId: uid(42),
              dateWorked: "2026-01-01",
              durationMinutes: 60,
              billedMinutes: 60,
              rateAtEntry: 100,
              currency: "EUR",
              narrative: "Drafted the NDA",
              invoiceNarrative: null,
              billable: true,
              noCharge: false,
              status: "draft",
            },
          ],
          [{ id: uid(42), name: "Member One" }],
        ]),
      }),
      expectRefPaths: ["entries[].entityId"],
    },
    {
      mode: "list",
      buildArgs: (refRegistry) => ({ matter_id: matterRef(refRegistry) }),
      tx: () => ({
        select: selectQueue([
          [
            {
              id: uid(44),
              entityId: null,
              userId: null,
              dateWorked: "2026-01-02",
              durationMinutes: 30,
              billedMinutes: 30,
              rateAtEntry: 0,
              currency: "XXX",
              narrative: "Unassigned internal work",
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
              entityId: uid(41),
              userId: uid(42),
              dateWorked: "2026-01-01",
              durationMinutes: 60,
              billedMinutes: 60,
              rateAtEntry: 100,
              currency: "EUR",
              narrative: "Drafted the NDA",
              invoiceNarrative: null,
              billable: true,
              noCharge: false,
              status: "draft",
            },
          ],
          [{ id: uid(42), name: "Member One" }],
        ]),
      }),
      expectRefPaths: ["entry.entityId", "entry.workspaceId"],
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
              reference: "Acme February",
              status: "draft",
              invoiceDate: "2026-02-01",
              dueDate: "2026-03-01",
              currency: "EUR",
              totalAmount: 2000,
              notes: "Net 30",
              paidAt: null,
              createdAt: new Date("2026-02-01"),
              updatedAt: new Date("2026-02-01"),
              timeEntries: [
                {
                  id: uid(47),
                  workItemId: uid(48),
                  dateWorked: "2026-02-01",
                  billedMinutes: 60,
                  rateAtEntry: 100,
                  currency: "EUR",
                  narrative: "Drafted the NDA",
                  invoiceNarrative: null,
                  status: "invoiced",
                  workItem: { id: uid(48), name: "NDA draft" },
                },
              ],
              expenses: [
                {
                  id: uid(49),
                  matterId: uid(50),
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
            }),
          },
        },
      }),
      expectRefPaths: [
        "invoice.workspaceId",
        "invoice.timeEntries[].entityId",
        "invoice.timeEntries[].entity.id",
        "invoice.expenses[].entityId",
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
  search_case_law: [
    {
      mode: "search",
      buildArgs: () => ({ query: "dobré mravy" }),
      setup: () => {
        searchDecisionsHandlerMock.mockResolvedValue({
          facets: null,
          hits: [
            {
              anchorId: null,
              caseNumber: "22 Cdo 1000/2020",
              citationCount: 3,
              country: "CZ",
              court: "Nejvyšší soud",
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
              headnote: null,
              languageAlternates: [],
              slug: "ns-22-cdo-1000-2020",
              sourceUrl: "https://example.test/decision",
            },
          ],
          nextCursor: null,
          totalCount: 1,
        } satisfies Awaited<ReturnType<typeof searchDecisionsHandler>>);
      },
      expectRefPaths: [],
    },
  ],
  read_case_law_decision: [
    {
      mode: "read",
      buildArgs: () => ({ decision_id: uid(54) }),
      setup: () => {
        readGatedDecisionWithDocumentMock.mockResolvedValue({
          documentPending: false,
          documentReadFailed: false,
          documentUnavailable: false,
          id: toSafeId<"caseLawDecision">(uid(54)),
          caseNumber: "22 Cdo 1000/2020",
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
          // `decisionDate` is a plain `date`-mode column (a "YYYY-MM-DD"
          // string), not a `Date` object.
          decisionDate: "2020-05-01",
          decisionType: "judgment",
          documentAst: null,
          documentUrl: null,
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
          sections: null,
          language: "cs",
          languageGroupKey: null,
          languageAlternates: [],
          metadata: {},
          slug: "ns-22-cdo-1000-2020",
          source: {
            id: toSafeId<"caseLawSource">(uid(59)),
            name: "NS ČR",
            adapterKey: "cz-ns",
            allowsDerivedAi: true,
          },
          sourceUrl: "https://example.test/decision",
          createdAt: new Date("2020-05-01T00:00:00.000Z"),
          updatedAt: new Date("2020-05-01T00:00:00.000Z"),
        } satisfies Awaited<ReturnType<typeof readGatedDecisionWithDocument>>);
      },
      expectRefPaths: [],
    },
  ],
  search_legislation: [
    {
      mode: "search",
      buildArgs: () => ({ query: "impuesto" }),
      setup: () => {
        searchConsolidatedLegislationMock.mockResolvedValue({
          data: [{ identificador: "BOE-A-2020-1", titulo: "Ley 1/2020" }],
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
            registryUrl: "https://ares.gov.cz/27074358",
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
              label: "Client name",
              inputType: "text",
              required: true,
              hint: null,
              options: null,
              formats: null,
              aiPrompt: null,
              aiAdapt: false,
              optionsFrom: null,
              dateFormat: null,
              parts: null,
              format: null,
            },
          ],
          conditions: [],
          computed: [],
          arrays: [],
        } satisfies DescribeTemplateResult);
      },
      expectRefPaths: [],
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
  searchDecisionsHandlerMock,
  readGatedDecisionWithDocumentMock,
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

afterEach(() => {
  analytics?.restore();
  analytics = null;
});

beforeEach(() => {
  analytics = installRecordingAnalytics();
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
  test("every declared outputRef path is exercised by some fixture call", () => {
    for (const [toolName, calls] of corpusEntries()) {
      // Derived from the entry's projection schema, the only artifact.
      const lists = deriveRefMediationEntry(
        READ_TOOL_REF_FIELD_MAP[toolName].projection,
      );
      const declared = lists.outputRefs.map((field) => field.path).sort();
      const exercised = [
        ...new Set(calls.flatMap((call) => call.expectRefPaths)),
      ].sort();
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
        const context = buildContext(call.tx?.() ?? {});

        const result = await runRegistryReadTool({
          args: call.buildArgs(refRegistry),
          context,
          refRegistry,
          toolName,
        });

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
        // behind a payload that merely looks well formed.
        expect(
          recordedExceptions(),
          `${toolName} (${call.mode}): the call reported an exception`,
        ).toEqual([]);
      });
    }
  }
});
