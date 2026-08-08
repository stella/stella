import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

import { toSafeId } from "@/api/lib/branded-types";
import type {
  ChatProjectionSchema,
  DehydratedInput,
  OutputRefField,
  RefMediationLists,
} from "@/api/lib/chat/projection-schema";
import type {
  AssertNoExtraFields,
  LIST_MATTERS_LIST_PROJECTION,
  LIST_PROPERTIES_PROJECTION,
} from "@/api/lib/chat/projections";

// Mocked so the fail-closed tests can assert the exact telemetry contract
// (paths only, never values) without touching the analytics client.
const captureErrorMock = mock();
void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
  getAnalytics: mock(() => ({ capture: mock(), flush: mock() })),
}));

const { createChatRefRegistry } = await import("@/api/lib/chat/ref-registry");
const {
  chatEntityRef,
  chatRef,
  containsRawUuid,
  deriveRefMediationEntry,
  passthroughId,
  PROJECTION_SCHEMA_FAILURE_MESSAGE,
  projectForChat,
  REF_PROJECTION_FAILURE_MESSAGE,
  renderProjectionShape,
  strippedField,
  unenumeratedJson,
} = await import("@/api/lib/chat/projection-schema");
const { READ_TOOL_REF_FIELD_MAP, WRITE_TOOL_REF_FIELD_MAP } =
  await import("./ref-field-map");

/**
 * The derivation contract: the mediation lists mechanically derived from a
 * converted tool's projection schema must reproduce the hand-written lists
 * they replaced (copied below as literals from the pre-conversion map), so
 * the conversion is provably behavior-preserving. The lists are allowlists,
 * so order is irrelevant: both sides are compared sorted. Where a schema
 * deliberately departs from its hand list (drift the hand list could never
 * surface), the departure is asserted explicitly with its reason.
 */

const sortedPaths = (paths: readonly string[]): readonly string[] =>
  [...paths].sort();

// Paths are unique non-linguistic keys, so a plain code-point comparison
// (not the app-locale collator) is the right sort here.
const sortedRefs = (
  refs: readonly OutputRefField[],
): readonly OutputRefField[] =>
  [...refs].sort((a, b) => (a.path < b.path ? -1 : 1));

const LIST_MATTERS_PROJECTION = READ_TOOL_REF_FIELD_MAP.list_matters.projection;
const READ_DOCUMENT_PROJECTION =
  READ_TOOL_REF_FIELD_MAP.read_document.projection;

const expectDerivedEquals = (
  projection: ChatProjectionSchema,
  expected: RefMediationLists,
): void => {
  const derived = deriveRefMediationEntry(projection);
  expect(sortedRefs(derived.outputRefs)).toEqual(
    sortedRefs(expected.outputRefs),
  );
  expect(sortedPaths(derived.passthroughIdPaths)).toEqual(
    sortedPaths(expected.passthroughIdPaths),
  );
  expect(sortedPaths(derived.stripPaths)).toEqual(
    sortedPaths(expected.stripPaths),
  );
};

// The hand-written list_matters entry the projection schema replaced.
const LIST_MATTERS_HAND_LISTS = {
  outputRefs: [
    { kind: "matter", path: "matters[].id" },
    { kind: "matter", path: "matter.id" },
    { kind: "contact", path: "contacts[].contactId" },
    {
      kind: "entity",
      path: "overview.recentEntities[].entityId",
      workspace: { from: "outputPath", path: "matter.id" },
    },
  ],
  passthroughIdPaths: [
    "contacts[].workspaceContactId",
    "members[].userId",
    "nextCursor",
  ],
  stripPaths: [
    "overview.recentEntities[].fieldId",
    "overview.recentEntities[].propertyId",
    "overview.recentEntities[].pdfFileId",
  ],
} as const satisfies RefMediationLists;

// The hand-written read_document entry the projection schema replaced.
const READ_DOCUMENT_HAND_LISTS = {
  outputRefs: [
    {
      kind: "entity",
      path: "entityId",
      workspace: { from: "inputEntity", param: "entity_id" },
    },
    { kind: "property", path: "fields[].propertyId" },
    { kind: "property", path: "version.fields[].propertyId" },
  ],
  passthroughIdPaths: [
    "version.id",
    "versions[].id",
    "version.fields[].id",
    "fields[].id",
    "diff.baseVersionId",
    "diff.targetVersionId",
    "versionsNextCursor",
  ],
  stripPaths: [],
} as const satisfies RefMediationLists;

/**
 * The one deliberate delta over the hand entry: the `FieldContent` file
 * variant's storage/derivative plumbing, which the hand lists never declared
 * and which tripped the prod UUID backstop on any document whose field held a
 * file (`content.id`/`content.pdfFileId`). The schema strips it at both field
 * paths (default and specific-version branch).
 */
const FILE_CONTENT_PLUMBING_KEYS = [
  "id",
  "sha256Hex",
  "pdfFileId",
  "pdfDerivative",
  "thumbnailFileId",
  "placeholder",
  "thumbnailDerivative",
] as const;

const READ_DOCUMENT_CONTENT_STRIPS = [
  "fields[].content",
  "version.fields[].content",
].flatMap((base) => FILE_CONTENT_PLUMBING_KEYS.map((key) => `${base}.${key}`));

/**
 * The remaining pre-conversion hand lists, one per tool, copied verbatim from
 * the map they were deleted from. Each case's `expected` is those lists plus
 * any documented departure. Empty lists are stated explicitly: a tool whose
 * payload carries no ids at all (resolve_rate, lookup_business_registry) is
 * an assertion too.
 */
type DerivationCase = {
  tool: string;
  projection: ChatProjectionSchema;
  expected: RefMediationLists;
};

const DERIVATION_CASES: readonly DerivationCase[] = [
  {
    tool: "list_contacts",
    projection: READ_TOOL_REF_FIELD_MAP.list_contacts.projection,
    expected: {
      outputRefs: [{ kind: "contact", path: "items[].id" }],
      passthroughIdPaths: ["nextCursor"],
      stripPaths: [],
    },
  },
  {
    tool: "search_across_matters",
    projection: READ_TOOL_REF_FIELD_MAP.search_across_matters.projection,
    expected: {
      outputRefs: [
        { kind: "matter", path: "hits[].workspaceId" },
        {
          kind: "entity",
          path: "hits[].entityId",
          workspace: { from: "sibling", key: "workspaceId" },
        },
      ],
      passthroughIdPaths: [],
      stripPaths: [],
    },
  },
  {
    tool: "read_content_across_matters",
    projection: READ_TOOL_REF_FIELD_MAP.read_content_across_matters.projection,
    expected: {
      outputRefs: [
        { kind: "matter", path: "workspaceId" },
        {
          kind: "entity",
          path: "entityId",
          workspace: { from: "sibling", key: "workspaceId" },
        },
      ],
      passthroughIdPaths: [],
      stripPaths: [],
    },
  },
  {
    tool: "read_contact",
    projection: READ_TOOL_REF_FIELD_MAP.read_contact.projection,
    expected: {
      outputRefs: [{ kind: "contact", path: "contactId" }],
      passthroughIdPaths: [],
      stripPaths: [],
    },
  },
  {
    tool: "list_documents",
    projection: READ_TOOL_REF_FIELD_MAP.list_documents.projection,
    expected: {
      outputRefs: [
        {
          kind: "entity",
          path: "documents[].id",
          workspace: { from: "inputParam", param: "matter_id" },
        },
        {
          kind: "entity",
          path: "documents[].parentId",
          workspace: { from: "inputParam", param: "matter_id" },
        },
      ],
      passthroughIdPaths: ["nextCursor"],
      stripPaths: [],
    },
  },
  {
    tool: "list_properties",
    projection: READ_TOOL_REF_FIELD_MAP.list_properties.projection,
    expected: {
      outputRefs: [{ kind: "property", path: "properties[].id" }],
      passthroughIdPaths: ["nextCursor"],
      stripPaths: [],
    },
  },
  {
    tool: "list_tasks",
    projection: READ_TOOL_REF_FIELD_MAP.list_tasks.projection,
    expected: {
      outputRefs: [
        {
          kind: "entity",
          path: "tasks[].id",
          workspace: { from: "inputParam", param: "matter_id" },
        },
        {
          kind: "entity",
          path: "task.taskId",
          workspace: { from: "inputEntity", param: "task_id" },
        },
        {
          kind: "entity",
          path: "task.links[].entity.id",
          workspace: { from: "inputEntityWorkspace", param: "task_id" },
        },
      ],
      passthroughIdPaths: [
        "task.assignees[].userId",
        "task.links[].linkId",
        "nextCursor",
      ],
      stripPaths: [],
    },
  },
  {
    tool: "list_clauses",
    projection: READ_TOOL_REF_FIELD_MAP.list_clauses.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: [
        "clauses[].id",
        "clauses[].categoryId",
        "clause.id",
        "clause.categoryId",
        "clause.variants[].id",
        "clause.versions[].id",
        "clause.createdBy",
        "categories[].id",
        "categories[].parentId",
        "version.id",
        "nextCursor",
      ],
      stripPaths: [],
    },
  },
  {
    tool: "list_playbooks",
    projection: READ_TOOL_REF_FIELD_MAP.list_playbooks.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: [
        "items[].id",
        "playbook.id",
        "playbook.positions.items[].sourceId",
        // Departure from the hand list, which licensed
        // `playbook.positions.items[].standard.clauseId`: `standard` was the
        // pre-v2 positions shape and no handler emits it, so the license was
        // stale documentation. The positions-v2 clause link lives at the
        // acceptable tier's ideal language, and it is the same org-scoped
        // clause-library handle list_clauses licenses.
        "playbook.positions.items[].tiers.acceptable.ideal.clauseId",
        "nextCursor",
      ],
      stripPaths: [
        "playbook.positions.items[].tiers.acceptable.rules[].id",
        "playbook.positions.items[].tiers.fallback.entries[].id",
        "playbook.positions.items[].tiers.notAcceptable.rules[].id",
      ],
    },
  },
  {
    tool: "list_time_entries",
    projection: READ_TOOL_REF_FIELD_MAP.list_time_entries.projection,
    expected: {
      outputRefs: [
        {
          kind: "entity",
          path: "entries[].entityId",
          workspace: { from: "inputParam", param: "matter_id" },
        },
        {
          kind: "entity",
          path: "entry.entityId",
          workspace: { from: "sibling", key: "workspaceId" },
        },
        { kind: "matter", path: "entry.workspaceId" },
      ],
      passthroughIdPaths: [
        "entries[].id",
        "entry.id",
        "entries[].userId",
        "entry.userId",
        "nextCursor",
      ],
      stripPaths: [],
    },
  },
  {
    tool: "resolve_rate",
    projection: READ_TOOL_REF_FIELD_MAP.resolve_rate.projection,
    expected: { outputRefs: [], passthroughIdPaths: [], stripPaths: [] },
  },
  {
    tool: "list_invoices",
    projection: READ_TOOL_REF_FIELD_MAP.list_invoices.projection,
    expected: {
      outputRefs: [
        {
          kind: "entity",
          path: "invoice.timeEntries[].entityId",
          workspace: { from: "outputPath", path: "invoice.workspaceId" },
        },
        {
          kind: "entity",
          path: "invoice.timeEntries[].entity.id",
          workspace: { from: "outputPath", path: "invoice.workspaceId" },
        },
        {
          kind: "entity",
          path: "invoice.expenses[].entityId",
          workspace: { from: "outputPath", path: "invoice.workspaceId" },
        },
        {
          kind: "entity",
          path: "invoice.expenses[].entity.id",
          workspace: { from: "outputPath", path: "invoice.workspaceId" },
        },
        { kind: "matter", path: "invoice.workspaceId" },
      ],
      passthroughIdPaths: [
        "invoices[].id",
        "invoice.id",
        "invoice.timeEntries[].id",
        "invoice.expenses[].id",
        "nextCursor",
      ],
      stripPaths: [],
    },
  },
  {
    tool: "get_usage",
    projection: READ_TOOL_REF_FIELD_MAP.get_usage.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: ["entitlement.id", "policy.id"],
      stripPaths: [],
    },
  },
  {
    tool: "search_case_law",
    projection: READ_TOOL_REF_FIELD_MAP.search_case_law.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: ["results[].decisionId", "nextCursor"],
      stripPaths: [],
    },
  },
  {
    tool: "read_case_law_decision",
    projection: READ_TOOL_REF_FIELD_MAP.read_case_law_decision.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: [
        "decision.decisionId",
        "decision.citationsFrom[].id",
        "decision.citationsFrom[].citedDecisionId",
        "decision.citationsTo[].id",
        "decision.citationsTo[].citingDecisionId",
        "decision.source.id",
        "nextCursor",
      ],
      stripPaths: [],
    },
  },
  {
    tool: "search_legislation",
    projection: READ_TOOL_REF_FIELD_MAP.search_legislation.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: [
        "lawId",
        "blockId",
        "law.lawId",
        "data[].identificador",
      ],
      stripPaths: [],
    },
  },
  {
    tool: "lookup_business_registry",
    projection: READ_TOOL_REF_FIELD_MAP.lookup_business_registry.projection,
    expected: { outputRefs: [], passthroughIdPaths: [], stripPaths: [] },
  },
  {
    tool: "list_templates",
    projection: READ_TOOL_REF_FIELD_MAP.list_templates.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: ["templates[].id", "nextCursor"],
      stripPaths: [],
    },
  },

  // --- Write tools ------------------------------------------------------
  {
    tool: "save_matter",
    projection: WRITE_TOOL_REF_FIELD_MAP.save_matter.projection,
    expected: {
      outputRefs: [{ kind: "matter", path: "matterId" }],
      passthroughIdPaths: [],
      stripPaths: [],
    },
  },
  {
    tool: "delete_matter",
    projection: WRITE_TOOL_REF_FIELD_MAP.delete_matter.projection,
    expected: { outputRefs: [], passthroughIdPaths: [], stripPaths: [] },
  },
  {
    tool: "save_contact",
    projection: WRITE_TOOL_REF_FIELD_MAP.save_contact.projection,
    expected: {
      outputRefs: [{ kind: "contact", path: "contactId" }],
      passthroughIdPaths: [],
      stripPaths: [],
    },
  },
  {
    tool: "delete_contact",
    projection: WRITE_TOOL_REF_FIELD_MAP.delete_contact.projection,
    expected: { outputRefs: [], passthroughIdPaths: [], stripPaths: [] },
  },
  {
    tool: "save_task",
    projection: WRITE_TOOL_REF_FIELD_MAP.save_task.projection,
    expected: {
      outputRefs: [
        {
          kind: "entity",
          path: "taskId",
          workspace: { from: "inputParam", param: "matter_id" },
        },
      ],
      passthroughIdPaths: [],
      stripPaths: [],
    },
  },
  {
    tool: "link_matter_contact",
    projection: WRITE_TOOL_REF_FIELD_MAP.link_matter_contact.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: ["workspaceContactId"],
      stripPaths: [],
    },
  },
  {
    tool: "save_document",
    projection: WRITE_TOOL_REF_FIELD_MAP.save_document.projection,
    expected: {
      outputRefs: [
        {
          kind: "entity",
          path: "entityId",
          workspace: { from: "inputParam", param: "matter_id" },
        },
      ],
      passthroughIdPaths: [],
      stripPaths: [],
    },
  },
  {
    tool: "delete_document",
    projection: WRITE_TOOL_REF_FIELD_MAP.delete_document.projection,
    expected: { outputRefs: [], passthroughIdPaths: [], stripPaths: [] },
  },
  {
    tool: "set_field_value",
    projection: WRITE_TOOL_REF_FIELD_MAP.set_field_value.projection,
    expected: { outputRefs: [], passthroughIdPaths: [], stripPaths: [] },
  },
  {
    tool: "save_time_entry",
    projection: WRITE_TOOL_REF_FIELD_MAP.save_time_entry.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: ["timeEntryId"],
      stripPaths: [],
    },
  },
  {
    tool: "delete_time_entry",
    projection: WRITE_TOOL_REF_FIELD_MAP.delete_time_entry.projection,
    expected: { outputRefs: [], passthroughIdPaths: [], stripPaths: [] },
  },
  {
    tool: "save_clause",
    projection: WRITE_TOOL_REF_FIELD_MAP.save_clause.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: ["clauseId"],
      stripPaths: [],
    },
  },
  {
    tool: "delete_clause",
    projection: WRITE_TOOL_REF_FIELD_MAP.delete_clause.projection,
    expected: { outputRefs: [], passthroughIdPaths: [], stripPaths: [] },
  },
  {
    tool: "run_playbook",
    projection: WRITE_TOOL_REF_FIELD_MAP.run_playbook.projection,
    expected: { outputRefs: [], passthroughIdPaths: [], stripPaths: [] },
  },
  {
    tool: "manage_organization",
    projection: WRITE_TOOL_REF_FIELD_MAP.manage_organization.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: ["memberId", "id"],
      stripPaths: [],
    },
  },
  {
    tool: "set_practice_jurisdictions",
    projection: WRITE_TOOL_REF_FIELD_MAP.set_practice_jurisdictions.projection,
    expected: { outputRefs: [], passthroughIdPaths: [], stripPaths: [] },
  },
  {
    tool: "save_template",
    projection: WRITE_TOOL_REF_FIELD_MAP.save_template.projection,
    expected: {
      outputRefs: [],
      passthroughIdPaths: ["templateId"],
      stripPaths: [],
    },
  },
];

describe("deriveRefMediationEntry", () => {
  test("list_matters: derived lists equal the previous hand-written entry", () => {
    expectDerivedEquals(LIST_MATTERS_PROJECTION, LIST_MATTERS_HAND_LISTS);
  });

  test("read_document: derived lists include file strips and processing-state mediation", () => {
    expectDerivedEquals(READ_DOCUMENT_PROJECTION, {
      outputRefs: [
        ...READ_DOCUMENT_HAND_LISTS.outputRefs,
        {
          kind: "matter",
          path: "contentState.remediation.arguments.input.params.workspaceId",
        },
        {
          kind: "entity",
          path: "contentState.remediation.arguments.input.params.entityId",
          workspace: { from: "inputEntity", param: "entity_id" },
        },
      ],
      passthroughIdPaths: [
        ...READ_DOCUMENT_HAND_LISTS.passthroughIdPaths,
        "contentState.remediation.arguments.input.body.fieldId",
        "contentState.runId",
        "contentState.sourceVersionId",
        "searchIndexState.runId",
        "searchIndexState.sourceVersionId",
      ],
      stripPaths: [
        ...READ_DOCUMENT_HAND_LISTS.stripPaths,
        ...READ_DOCUMENT_CONTENT_STRIPS,
      ],
    });
  });

  for (const { tool, projection, expected } of DERIVATION_CASES) {
    test(`${tool}: derived lists equal the previous hand-written entry`, () => {
      expectDerivedEquals(projection, expected);
    });
  }

  test("every chat-projectable entry in both maps has a derivation test", () => {
    const projectable = [
      ...Object.entries(READ_TOOL_REF_FIELD_MAP),
      ...Object.entries(WRITE_TOOL_REF_FIELD_MAP),
    ]
      .filter(([, entry]) => entry.chatProjectable)
      .map(([name]) => name)
      .sort();
    const covered = [
      "list_matters",
      "read_document",
      ...DERIVATION_CASES.map(({ tool }) => tool),
    ].sort();
    expect(covered).toEqual(projectable);
  });

  test("is memoized per schema", () => {
    expect(deriveRefMediationEntry(LIST_MATTERS_PROJECTION)).toBe(
      deriveRefMediationEntry(LIST_MATTERS_PROJECTION),
    );
  });
});

describe("projectForChat", () => {
  const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
  const ROGUE_UUID = "4e919658-a448-5354-8e3a-e99911214d2c";
  const ENTITY_UUID = "c09ec856-d945-5ecc-82e3-bb5382165f34";
  const LINKED_ENTITY_UUID = "1e7f7f2a-9b2b-4c40-8ab1-2f5b6c7d8e9f";
  const CONTACT_UUID = "6111c8e9-1404-5b6f-8a9a-0e3a93e8179a";
  const PROPERTY_UUID = "37286c24-6145-572e-ad27-15a1d4454d59";

  const emptyDehydration = (): DehydratedInput => ({
    args: {},
    dehydratedEntityRefs: new Map(),
    resolvedEntityParams: {},
    resolvedMatterParams: {},
  });

  type ProjectArgs = {
    schema: ChatProjectionSchema;
    payload: unknown;
    refRegistry?: ReturnType<typeof createChatRefRegistry>;
    dehydration?: DehydratedInput;
  };

  const project = ({
    schema,
    payload,
    refRegistry = createChatRefRegistry(),
    dehydration = emptyDehydration(),
  }: ProjectArgs) =>
    projectForChat({
      dehydration,
      payload,
      refRegistry,
      schema,
      source: "run-registry-tool",
      toolName: "test_tool",
    });

  beforeEach(() => {
    captureErrorMock.mockClear();
  });

  test("an undeclared field fails the strict parse with its path, never its value", () => {
    const result = project({
      schema: LIST_MATTERS_PROJECTION,
      payload: {
        matters: [
          {
            id: WS_UUID,
            name: "Acme",
            reference: "REF-1",
            status: "active",
            lastActivityAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
            // The class under guard: a handler field nobody classified,
            // carrying a UUID. The strict parse refuses it by construction.
            plumbingId: ROGUE_UUID,
          },
        ],
        nextCursor: null,
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("server-defect");
      expect(result.error.message).toBe(PROJECTION_SCHEMA_FAILURE_MESSAGE);
      expect(JSON.stringify(result.error)).not.toContain(ROGUE_UUID);
    }
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: PROJECTION_SCHEMA_FAILURE_MESSAGE }),
      expect.objectContaining({
        paths: expect.stringContaining("matters[].plumbingId"),
        source: "run-registry-tool",
        toolName: "test_tool",
      }),
    );
    const [, telemetryContext] = captureErrorMock.mock.calls.at(0) ?? [];
    expect(JSON.stringify(telemetryContext)).not.toContain(ROGUE_UUID);
  });

  test("each simple ref kind hydrates to the registry's chat ref", () => {
    const refRegistry = createChatRefRegistry();
    const matterRef = refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID));
    const contactRef = refRegistry.toContactRef(
      toSafeId<"contact">(CONTACT_UUID),
    );
    const propertyRef = refRegistry.toPropertyRef(
      toSafeId<"property">(PROPERTY_UUID),
    );
    const schema: ChatProjectionSchema = v.strictObject({
      contactId: chatRef("contact"),
      matterId: chatRef("matter"),
      propertyId: chatRef("property"),
    });

    const projected = project({
      payload: {
        contactId: CONTACT_UUID,
        matterId: WS_UUID,
        propertyId: PROPERTY_UUID,
      },
      refRegistry,
      schema,
    }).unwrap();

    expect(projected).toEqual({
      contactId: contactRef,
      matterId: matterRef,
      propertyId: propertyRef,
    });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("strippedField leaves are omitted, UUIDs inside them and all", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      name: v.string(),
      pdfFileId: strippedField(),
      thumbnail: v.optional(strippedField()),
    });

    const projected = project({
      payload: {
        name: "NDA draft",
        pdfFileId: ROGUE_UUID,
        thumbnail: { fileId: WS_UUID },
      },
      schema,
    }).unwrap();

    expect(projected).toEqual({ name: "NDA draft" });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("passthroughId survives verbatim, UUID-shaped or not", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      cursor: v.nullable(passthroughId()),
      versionId: passthroughId(),
    });

    const projected = project({
      payload: { cursor: null, versionId: WS_UUID },
      schema,
    }).unwrap();

    expect(projected).toEqual({ cursor: null, versionId: WS_UUID });
  });

  test("sibling workspace source reads the raw payload, not the hydrated output", () => {
    const refRegistry = createChatRefRegistry();
    const schema: ChatProjectionSchema = v.strictObject({
      hits: v.array(
        v.strictObject({
          // Declared (and emitted) BEFORE the entity id: a walk that hydrated
          // in place would overwrite the sibling workspace UUID with `mat_N`
          // before the entity ref could read it. The raw-snapshot guarantee is
          // what this test pins.
          workspaceId: chatRef("matter"),
          entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
          name: v.string(),
        }),
      ),
    });

    const projected = project({
      payload: {
        hits: [{ workspaceId: WS_UUID, entityId: ENTITY_UUID, name: "Brief" }],
      },
      refRegistry,
      schema,
    }).unwrap();

    expect(projected).toEqual({
      hits: [
        {
          entityId: refRegistry.toEntityRef({
            entityId: toSafeId<"entity">(ENTITY_UUID),
            workspaceId: toSafeId<"workspace">(WS_UUID),
          }),
          name: "Brief",
          workspaceId: refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID)),
        },
      ],
    });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("outputPath workspace source reads the raw payload across the tree", () => {
    const refRegistry = createChatRefRegistry();
    const schema: ChatProjectionSchema = v.strictObject({
      invoice: v.strictObject({
        workspaceId: chatRef("matter"),
        items: v.array(
          v.strictObject({
            entityId: chatEntityRef({
              from: "outputPath",
              path: "invoice.workspaceId",
            }),
          }),
        ),
      }),
    });

    const projected = project({
      payload: {
        invoice: {
          workspaceId: WS_UUID,
          items: [{ entityId: ENTITY_UUID }],
        },
      },
      refRegistry,
      schema,
    }).unwrap();

    expect(projected).toEqual({
      invoice: {
        items: [
          {
            entityId: refRegistry.toEntityRef({
              entityId: toSafeId<"entity">(ENTITY_UUID),
              workspaceId: toSafeId<"workspace">(WS_UUID),
            }),
          },
        ],
        workspaceId: refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID)),
      },
    });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("inputParam workspace source draws from the resolved matter input", () => {
    const refRegistry = createChatRefRegistry();
    const schema: ChatProjectionSchema = v.strictObject({
      documents: v.array(
        v.strictObject({
          id: chatEntityRef({ from: "inputParam", param: "matter_id" }),
        }),
      ),
    });

    const projected = project({
      dehydration: {
        ...emptyDehydration(),
        resolvedMatterParams: { matter_id: toSafeId<"workspace">(WS_UUID) },
      },
      payload: { documents: [{ id: ENTITY_UUID }] },
      refRegistry,
      schema,
    }).unwrap();

    expect(projected).toEqual({
      documents: [
        {
          id: refRegistry.toEntityRef({
            entityId: toSafeId<"entity">(ENTITY_UUID),
            workspaceId: toSafeId<"workspace">(WS_UUID),
          }),
        },
      ],
    });
  });

  test("inputEntityWorkspace mints a new ref for a different entity in the input entity's workspace", () => {
    const refRegistry = createChatRefRegistry();
    const taskRef = refRegistry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });
    const schema: ChatProjectionSchema = v.strictObject({
      taskId: chatEntityRef({ from: "inputEntity", param: "task_id" }),
      linked: v.strictObject({
        id: chatEntityRef({ from: "inputEntityWorkspace", param: "task_id" }),
      }),
    });

    const projected = project({
      dehydration: {
        ...emptyDehydration(),
        dehydratedEntityRefs: new Map([[ENTITY_UUID, taskRef]]),
        resolvedEntityParams: { task_id: toSafeId<"workspace">(WS_UUID) },
      },
      payload: { taskId: ENTITY_UUID, linked: { id: LINKED_ENTITY_UUID } },
      refRegistry,
      schema,
    }).unwrap();

    // The task's own id echoes the dehydrated input ref (no workspace lookup);
    // the linked entity (a different uuid) mints a new ref scoped to the same
    // workspace, not the task's own ref and not an un-hydrated raw uuid.
    expect(projected).toEqual({
      linked: {
        id: refRegistry.toEntityRef({
          entityId: toSafeId<"entity">(LINKED_ENTITY_UUID),
          workspaceId: toSafeId<"workspace">(WS_UUID),
        }),
      },
      taskId: taskRef,
    });
    expect(containsRawUuid(projected)).toBe(false);
  });

  test("an entity echo reuses the dehydrated ref even under another workspace source", () => {
    const refRegistry = createChatRefRegistry();
    const entityRef = refRegistry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });
    // read_content_across_matters-style: the field declares a sibling source
    // for non-echo payloads, but the output entity IS the request's own input,
    // so the reuse map wins without consulting the sibling.
    const schema: ChatProjectionSchema = v.strictObject({
      entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
      workspaceId: chatRef("matter"),
    });

    const projected = project({
      dehydration: {
        ...emptyDehydration(),
        dehydratedEntityRefs: new Map([[ENTITY_UUID, entityRef]]),
      },
      payload: { entityId: ENTITY_UUID, workspaceId: WS_UUID },
      refRegistry,
      schema,
    }).unwrap();

    expect(projected).toEqual({
      entityId: entityRef,
      workspaceId: refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID)),
    });
  });

  test("unenumeratedJson passes through unmodified when it carries no UUID", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      content: unenumeratedJson(),
      question: v.string(),
    });
    const content = {
      nodes: [{ kind: "text", value: "Limitation of liability" }],
      type: "single-select",
    };

    const projected = project({
      payload: { content, question: "Which cap applies?" },
      schema,
    }).unwrap();

    expect(projected).toEqual({ content, question: "Which cap applies?" });
  });

  test("the UUID invariant still covers unenumeratedJson contents, unlicensed", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      content: unenumeratedJson(),
    });

    const result = project({
      payload: {
        content: { nodes: [{ value: `see ${ROGUE_UUID}` }] },
      },
      schema,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("server-defect");
      expect(result.error.message).toBe(REF_PROJECTION_FAILURE_MESSAGE);
    }
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: REF_PROJECTION_FAILURE_MESSAGE }),
      {
        path: "content.nodes[].value",
        source: "run-registry-tool",
        toolName: "test_tool",
      },
    );
    const [, telemetryContext] = captureErrorMock.mock.calls.at(0) ?? [];
    expect(JSON.stringify(telemetryContext)).not.toContain(ROGUE_UUID);
  });

  test("a UUID embedded in a declared plain string fails closed with its path", () => {
    const schema: ChatProjectionSchema = v.strictObject({
      matters: v.array(v.strictObject({ reference: v.string() })),
    });

    const result = project({
      payload: { matters: [{ reference: `REF-${ROGUE_UUID}` }] },
      schema,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toBe(REF_PROJECTION_FAILURE_MESSAGE);
      expect(result.error.message).not.toContain(ROGUE_UUID);
    }
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: REF_PROJECTION_FAILURE_MESSAGE }),
      expect.objectContaining({ path: "matters[].reference" }),
    );
  });

  test("an entity ref whose workspace is unrecoverable fails closed instead of leaking", () => {
    // The sibling workspace slot is null, so no ref can be minted; the raw
    // entity UUID would survive at an entity-ref position, which is never
    // licensed, so the invariant refuses the payload.
    const schema: ChatProjectionSchema = v.strictObject({
      entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
      workspaceId: v.nullable(chatRef("matter")),
    });

    const result = project({
      payload: { entityId: ENTITY_UUID, workspaceId: null },
      schema,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.kind).toBe("server-defect");
      expect(result.error.message).toBe(REF_PROJECTION_FAILURE_MESSAGE);
    }
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: REF_PROJECTION_FAILURE_MESSAGE }),
      expect.objectContaining({ path: "entityId" }),
    );
  });

  test("a matching payload with no ids projects to the declared shape verbatim", () => {
    const payload = {
      matters: [
        {
          id: WS_UUID,
          name: "Acme",
          reference: "REF-1",
          status: "active",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    const refRegistry = createChatRefRegistry();

    const projected = project({
      payload,
      refRegistry,
      schema: LIST_MATTERS_PROJECTION,
    }).unwrap();

    expect(projected).toEqual({
      matters: [
        {
          id: refRegistry.toMatterRef(toSafeId<"workspace">(WS_UUID)),
          name: "Acme",
          reference: "REF-1",
          status: "active",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(containsRawUuid(projected)).toBe(false);
  });
});

describe("renderProjectionShape", () => {
  test("read_document renders a terse shape naming the model-facing keys", () => {
    const shape = renderProjectionShape(READ_DOCUMENT_PROJECTION);

    expect(shape).toContain("entityId");
    expect(shape).toContain("fields: { id, propertyId, content: … }[]");
    expect(shape).toContain("versions?");
    expect(shape).toContain("versionsNextCursor?");
    expect(shape).toContain("diff");
    // Stripped file plumbing must not be advertised to the model.
    expect(shape).not.toContain("sha256Hex");
    expect(shape).not.toContain("pdfFileId");
  });

  test("list_matters renders both branches joined as a union", () => {
    const shape = renderProjectionShape(LIST_MATTERS_PROJECTION);

    expect(shape).toContain(
      "matters: { id, name, reference, status, lastActivityAt, createdAt }[]",
    );
    expect(shape).toContain(" | ");
    expect(shape).toContain("contacts");
    // Stripped overview plumbing must not be advertised either.
    expect(shape).not.toContain("fieldId");
  });
});

/**
 * The compile-time half of the contract the runtime strict parse enforces: a
 * handler payload carrying a field its projection does not classify must fail
 * typecheck at the construction site, not at runtime in chat. Both tie
 * mechanisms are exercised: `satisfies` for object-literal payloads (excess
 * property checking) and `AssertNoExtraFields` for payloads a shared helper
 * builds. Nothing here runs; a `@ts-expect-error` whose error never
 * materializes is itself a typecheck failure, which is the assertion.
 */
describe("compile-time payload ties", () => {
  test("an unclassified field fails against the projection input", () => {
    const withExtraField = {
      matters: [],
      nextCursor: null,
      // @ts-expect-error `totalCount` is not declared by the list branch.
      totalCount: 0,
    } satisfies v.InferInput<typeof LIST_MATTERS_LIST_PROJECTION>;

    const withoutExtraField = {
      matters: [],
      nextCursor: null,
    } satisfies v.InferInput<typeof LIST_MATTERS_LIST_PROJECTION>;

    // Payloads a helper builds get the same guard through AssertNoExtraFields,
    // which names the offending keys instead of relying on literal freshness.
    const namedWithExtraField: AssertNoExtraFields<
      // @ts-expect-error `total` is not declared by LIST_PROPERTIES_PROJECTION.
      { properties: []; nextCursor: null; total: number },
      v.InferInput<typeof LIST_PROPERTIES_PROJECTION>
    > = { properties: [], nextCursor: null, total: 0 };

    const namedWithoutExtraField: AssertNoExtraFields<
      { properties: []; nextCursor: null },
      v.InferInput<typeof LIST_PROPERTIES_PROJECTION>
    > = { properties: [], nextCursor: null };

    expect(withExtraField.matters).toEqual(withoutExtraField.matters);
    expect(namedWithExtraField.properties).toEqual(
      namedWithoutExtraField.properties,
    );
  });
});
