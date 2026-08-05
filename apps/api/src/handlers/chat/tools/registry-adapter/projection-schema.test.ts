import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type {
  ChatProjectionSchema,
  OutputRefField,
  RefMediationLists,
} from "./projection-schema";
import {
  applyProjectionSchema,
  deriveRefMediationEntry,
  renderProjectionShape,
} from "./projection-schema";
import {
  READ_TOOL_REF_FIELD_MAP,
  WRITE_TOOL_REF_FIELD_MAP,
} from "./ref-field-map";

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

  test("read_document: derived lists equal the previous hand-written entry plus the file-content strips", () => {
    expectDerivedEquals(READ_DOCUMENT_PROJECTION, {
      outputRefs: READ_DOCUMENT_HAND_LISTS.outputRefs,
      passthroughIdPaths: READ_DOCUMENT_HAND_LISTS.passthroughIdPaths,
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

describe("applyProjectionSchema", () => {
  const ROGUE_UUID = "4e919658-a448-5354-8e3a-e99911214d2c";

  test("an undeclared field fails the strict parse with its path, never its value", () => {
    const result = applyProjectionSchema({
      schema: LIST_MATTERS_PROJECTION,
      payload: {
        matters: [
          {
            id: "0dc54d0c-10d7-501d-897e-e801dbd0998c",
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
      expect(result.error.issuePaths).toContain("matters[].plumbingId");
      expect(JSON.stringify(result.error)).not.toContain(ROGUE_UUID);
    }
  });

  test("a matching payload parses to the declared shape", () => {
    const payload = {
      matters: [
        {
          id: "0dc54d0c-10d7-501d-897e-e801dbd0998c",
          name: "Acme",
          reference: "REF-1",
          status: "active",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };

    const result = applyProjectionSchema({
      schema: LIST_MATTERS_PROJECTION,
      payload,
    });

    expect(Result.isError(result)).toBe(false);
    expect(result.unwrap()).toEqual(payload);
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
