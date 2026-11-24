import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  fromProseDoc,
  toProseDoc,
} from "@stll/folio-core/prosemirror/conversion";
import { schema } from "@stll/folio-core/prosemirror/schema";
import { createDocx, parseDocx } from "@stll/folio-core/server";
import { assertProperty } from "@stll/property-testing";

import {
  collectEvidenceReferences,
  createEvidenceField,
  EVIDENCE_DERIVED_FIELDS,
  evidenceFieldInsertion,
  evidenceLabel,
} from "./evidence-reference";
import type { EvidenceReference } from "./evidence-reference";

const source = (id: number) =>
  ({
    profile: "cs-evidence",
    workspaceId: "10000000-0000-4000-8000-000000000001",
    entityId: `20000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    entityVersionId: "30000000-0000-4000-8000-000000000001",
    fieldId: `40000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    title: "Faktura ze dne 12. 3. 2026",
  }) as const satisfies EvidenceReference;

const documentWith = (ids: number[]) =>
  schema.node("doc", null, [
    schema.node(
      "paragraph",
      null,
      ids.flatMap((id) => [
        createEvidenceField(schema, source(id)),
        schema.text(": Faktura "),
      ]),
    ),
  ]);

describe("evidence references", () => {
  test("numbering follows first appearance, deduplicates sources and reaches a fixed point", () => {
    assertProperty(
      "numbering follows first appearance, deduplicates sources and reaches a fixed point",
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 60,
        }),
        (ids) => {
          const instructions = ids.map(
            (id) => evidenceFieldInsertion(source(id)).instruction,
          );
          expect(instructions.every(EVIDENCE_DERIVED_FIELDS.owns)).toBe(true);
          const labels = EVIDENCE_DERIVED_FIELDS.displayTexts(instructions);
          const first = [...new Set(ids)];
          expect(labels).toEqual(
            ids.map((id) => evidenceLabel(first.indexOf(id) + 1)),
          );
          const references = collectEvidenceReferences(
            documentWith(ids),
          ).references;
          expect(references.map(({ reference }) => reference.entityId)).toEqual(
            first.map((id) => source(id).entityId),
          );
          expect(references.map(({ number }) => number)).toEqual(
            first.map((_, index) => index + 1),
          );
          // Labels derived again from the same fields do not change.
          expect(EVIDENCE_DERIVED_FIELDS.displayTexts(instructions)).toEqual(
            labels,
          );
        },
      ),
      {},
    );
  });

  test("removing the first exhibit renumbers later references", () => {
    const instructions = [1, 2, 2].map(
      (id) => evidenceFieldInsertion(source(id)).instruction,
    );
    expect(EVIDENCE_DERIVED_FIELDS.displayTexts(instructions)).toEqual([
      evidenceLabel(1),
      evidenceLabel(2),
      evidenceLabel(2),
    ]);
    expect(EVIDENCE_DERIVED_FIELDS.displayTexts(instructions.slice(1))).toEqual(
      [evidenceLabel(1), evidenceLabel(1)],
    );
  });

  test("DOCX save and reopen preserve source identity, generated label and ordinary prose", async () => {
    const doc = documentWith([1]);
    const parsedDocument = await parseDocx(
      await createDocx(
        fromProseDoc(doc, undefined, { stylesheetSource: { type: "package" } }),
      ),
    );
    const reopened = toProseDoc(parsedDocument);
    const collected = collectEvidenceReferences(reopened);
    expect(collected.references).toHaveLength(1);
    expect(collected.references.at(0)?.reference).toEqual(source(1));
    expect(reopened.textBetween(0, reopened.content.size)).toBe(
      "Důkaz 1: Faktura ",
    );
    const second = toProseDoc(
      await parseDocx(
        await createDocx(
          fromProseDoc(reopened, parsedDocument, {
            stylesheetSource: { type: "package" },
          }),
        ),
      ),
    );
    expect(
      collectEvidenceReferences(second).references.at(0)?.reference,
    ).toEqual(source(1));
  });

  test("malformed fields remain visible as invalid, and tracked deletions do not receive numbers", () => {
    const broken = createEvidenceField(schema, source(1));
    const invalid = broken.type.create({
      ...broken.attrs,
      instruction: "ADDIN STELLA_EVIDENCE_V1 %broken",
    });
    const deleted = createEvidenceField(schema, source(2)).mark([
      schema.mark("deletion", { id: "1", author: "Reviewer" }),
    ]);
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        invalid,
        deleted,
        createEvidenceField(schema, source(3)),
      ]),
    ]);
    const collected = collectEvidenceReferences(doc);
    expect(collected.invalidPositions).toEqual([1]);
    expect(collected.references.map(({ reference }) => reference)).toEqual([
      source(3),
    ]);
  });

  test("each source identity component distinguishes exhibits", () => {
    const first = source(1);
    const variants = [
      first,
      {
        ...first,
        workspaceId: "10000000-0000-4000-8000-000000000002",
      },
      {
        ...first,
        entityId: "20000000-0000-4000-8000-000000000002",
      },
      {
        ...first,
        entityVersionId: "30000000-0000-4000-8000-000000000002",
      },
      {
        ...first,
        fieldId: "40000000-0000-4000-8000-000000000002",
      },
    ] satisfies EvidenceReference[];
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        variants.flatMap((reference) => [
          createEvidenceField(schema, reference),
          schema.text(" "),
        ]),
      ),
    ]);
    expect(
      collectEvidenceReferences(doc).references.map(
        ({ reference, number }) => ({ reference, number }),
      ),
    ).toEqual(
      variants.map((reference, index) => ({
        reference,
        number: index + 1,
      })),
    );
  });
});
