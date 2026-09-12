import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { EditorState, TextSelection } from "prosemirror-state";

import {
  fromProseDoc,
  toProseDoc,
} from "@stll/folio-core/prosemirror/conversion";
import { schema } from "@stll/folio-core/prosemirror/schema";
import { createDocx, parseDocx } from "@stll/folio-core/server";

import {
  collectEvidenceReferences,
  createEvidenceField,
  createEvidenceReferencesPlugin,
  evidenceLabel,
  readEvidenceField,
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
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 60,
        }),
        (ids) => {
          let state = EditorState.create({
            schema,
            plugins: [createEvidenceReferencesPlugin()],
          });
          state = state.applyTransaction(
            state.tr.replaceWith(
              0,
              state.doc.content.size,
              documentWith(ids).content,
            ),
          ).state;
          const references = collectEvidenceReferences(state.doc).references;
          expect(references).toHaveLength(new Set(ids).size);
          expect(references.map(({ reference }) => reference.entityId)).toEqual(
            [...new Set(ids)].map((id) => source(id).entityId),
          );
          for (const entry of references) {
            for (const position of entry.positions) {
              const node = state.doc.nodeAt(position);
              expect(node).not.toBeNull();
              if (node === null) {
                throw new Error("Expected evidence field");
              }
              expect(readEvidenceField(node)).toMatchObject({
                type: "reference",
                displayText: evidenceLabel(entry.number),
              });
            }
          }
          const unchanged = state.applyTransaction(
            state.tr.setSelection(TextSelection.atEnd(state.doc)),
          );
          expect(unchanged.transactions).toHaveLength(1);
          expect(unchanged.state.doc.eq(state.doc)).toBe(true);
        },
      ),
    );
  });

  test("removing the first exhibit renumbers later references and undo restores them", async () => {
    const { closeHistory, history, undo } = await import("prosemirror-history");
    let state = EditorState.create({
      schema,
      plugins: [history(), createEvidenceReferencesPlugin()],
    });
    state = state.applyTransaction(
      state.tr.replaceWith(
        0,
        state.doc.content.size,
        documentWith([1, 2, 2]).content,
      ),
    ).state;
    const original = state.doc;
    state = state.applyTransaction(closeHistory(state.tr).delete(1, 2)).state;
    expect(
      collectEvidenceReferences(state.doc).references.map(
        ({ number }) => number,
      ),
    ).toEqual([1]);
    undo(state, (transaction) => {
      state = state.applyTransaction(transaction).state;
    });
    expect(state.doc.eq(original)).toBe(true);
  });

  test("DOCX save and reopen preserve source identity, generated label and ordinary prose", async () => {
    const doc = documentWith([1]);
    const parsedDocument = await parseDocx(await createDocx(fromProseDoc(doc)));
    const reopened = toProseDoc(parsedDocument);
    const collected = collectEvidenceReferences(reopened);
    expect(collected.references).toHaveLength(1);
    expect(collected.references.at(0)?.reference).toEqual(source(1));
    expect(reopened.textBetween(0, reopened.content.size)).toBe(
      "Důkaz 1: Faktura ",
    );
    const second = toProseDoc(
      await parseDocx(await createDocx(fromProseDoc(reopened, parsedDocument))),
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

  test("different source versions remain distinct exhibits", () => {
    const first = source(1);
    const next = {
      ...first,
      entityVersionId: "30000000-0000-4000-8000-000000000002",
      fieldId: "40000000-0000-4000-8000-000000000002",
    };
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        createEvidenceField(schema, first),
        createEvidenceField(schema, next),
      ]),
    ]);
    expect(
      collectEvidenceReferences(doc).references.map(
        ({ reference, number }) => ({ reference, number }),
      ),
    ).toEqual([
      { reference: first, number: 1 },
      { reference: next, number: 2 },
    ]);
  });
});
