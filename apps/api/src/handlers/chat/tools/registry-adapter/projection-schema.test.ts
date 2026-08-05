import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { OutputRefField } from "./projection-schema";
import {
  applyProjectionSchema,
  deriveRefMediationEntry,
  renderProjectionShape,
} from "./projection-schema";
import { READ_TOOL_REF_FIELD_MAP } from "./ref-field-map";

/**
 * The derivation contract: the mediation lists mechanically derived from a
 * converted tool's projection schema must reproduce the hand-written lists
 * they replaced (copied below as literals from the pre-conversion map), so
 * the conversion is provably behavior-preserving. The lists are allowlists,
 * so order is irrelevant: both sides are compared sorted.
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
} as const satisfies {
  outputRefs: readonly OutputRefField[];
  passthroughIdPaths: readonly string[];
  stripPaths: readonly string[];
};

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
} as const satisfies {
  outputRefs: readonly OutputRefField[];
  passthroughIdPaths: readonly string[];
  stripPaths: readonly string[];
};

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

describe("deriveRefMediationEntry", () => {
  test("list_matters: derived lists equal the previous hand-written entry", () => {
    const derived = deriveRefMediationEntry(LIST_MATTERS_PROJECTION);

    expect(sortedRefs(derived.outputRefs)).toEqual(
      sortedRefs(LIST_MATTERS_HAND_LISTS.outputRefs),
    );
    expect(sortedPaths(derived.passthroughIdPaths)).toEqual(
      sortedPaths(LIST_MATTERS_HAND_LISTS.passthroughIdPaths),
    );
    expect(sortedPaths(derived.stripPaths)).toEqual(
      sortedPaths(LIST_MATTERS_HAND_LISTS.stripPaths),
    );
  });

  test("read_document: derived lists equal the previous hand-written entry plus the file-content strips", () => {
    const derived = deriveRefMediationEntry(READ_DOCUMENT_PROJECTION);

    expect(sortedRefs(derived.outputRefs)).toEqual(
      sortedRefs(READ_DOCUMENT_HAND_LISTS.outputRefs),
    );
    expect(sortedPaths(derived.passthroughIdPaths)).toEqual(
      sortedPaths(READ_DOCUMENT_HAND_LISTS.passthroughIdPaths),
    );
    expect(sortedPaths(derived.stripPaths)).toEqual(
      sortedPaths([
        ...READ_DOCUMENT_HAND_LISTS.stripPaths,
        ...READ_DOCUMENT_CONTENT_STRIPS,
      ]),
    );
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
