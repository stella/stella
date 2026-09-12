import { panic, Result } from "better-result";
import type { Node as ProseMirrorNode, Schema } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import * as v from "valibot";

import { readFieldAttrs } from "@stll/folio-core/prosemirror/attrs";
import type { FieldAttrs } from "@stll/folio-core/prosemirror/schema";

const EVIDENCE_INSTRUCTION_PREFIX = "ADDIN STELLA_EVIDENCE_V1 ";

const evidenceReferenceSchema = v.object({
  profile: v.literal("cs-evidence"),
  workspaceId: v.pipe(v.string(), v.uuid()),
  entityId: v.pipe(v.string(), v.uuid()),
  entityVersionId: v.pipe(v.string(), v.uuid()),
  fieldId: v.pipe(v.string(), v.uuid()),
  title: v.pipe(v.string(), v.nonEmpty(), v.maxLength(512)),
});

export type EvidenceReference = v.InferOutput<typeof evidenceReferenceSchema>;

type EvidenceField =
  | { type: "other" }
  | { type: "invalid" }
  | { type: "reference"; reference: EvidenceReference; displayText: string };

export const readEvidenceField = (node: ProseMirrorNode): EvidenceField => {
  if (node.type.name !== "field") {
    return { type: "other" };
  }
  const attrs = readFieldAttrs(node);
  if (
    !attrs.ok ||
    !attrs.value.instruction.startsWith(EVIDENCE_INSTRUCTION_PREFIX)
  ) {
    return { type: "other" };
  }
  const decoded = Result.try((): unknown =>
    JSON.parse(
      decodeURIComponent(
        attrs.value.instruction.slice(EVIDENCE_INSTRUCTION_PREFIX.length),
      ),
    ),
  );
  if (Result.isError(decoded)) {
    return { type: "invalid" };
  }
  const parsed = v.safeParse(evidenceReferenceSchema, decoded.value);
  return parsed.success
    ? {
        type: "reference",
        reference: parsed.output,
        displayText: attrs.value.displayText,
      }
    : { type: "invalid" };
};

const sourceKey = (reference: EvidenceReference) =>
  `${reference.workspaceId}/${reference.entityId}/${reference.entityVersionId}/${reference.fieldId}`;

export const evidenceLabel = (number: number) => `Důkaz ${number}`;

export const createEvidenceField = (
  schema: Schema,
  reference: EvidenceReference,
) =>
  schema.node("field", {
    fieldType: "UNKNOWN",
    instruction: `${EVIDENCE_INSTRUCTION_PREFIX}${encodeURIComponent(JSON.stringify(v.parse(evidenceReferenceSchema, reference)))}`,
    displayText: evidenceLabel(1),
    fieldKind: "simple",
    fldLock: true,
    dirty: false,
  } satisfies FieldAttrs);

export const collectEvidenceReferences = (doc: ProseMirrorNode) => {
  const references: {
    reference: EvidenceReference;
    number: number;
    positions: number[];
  }[] = [];
  const bySource = new Map<string, (typeof references)[number]>();
  const invalidPositions: number[] = [];
  doc.descendants((node, position) => {
    // A tracked deletion is absent from the final pleading, including its descendants.
    if (node.marks.some((mark) => mark.type.name === "deletion")) {
      return false;
    }
    const field = readEvidenceField(node);
    switch (field.type) {
      case "other":
        return true;
      case "invalid":
        invalidPositions.push(position);
        return false;
      case "reference": {
        const key = sourceKey(field.reference);
        const existing = bySource.get(key);
        if (existing !== undefined) {
          existing.positions.push(position);
          return false;
        }
        const number = references.length + 1;
        const entry = {
          reference: field.reference,
          number,
          positions: [position],
        };
        bySource.set(key, entry);
        references.push(entry);
        return false;
      }
      default:
        field satisfies never;
        return panic("Unhandled evidence field");
    }
  });
  return { references, invalidPositions };
};

export const evidenceReferencesKey = new PluginKey(
  "stella-evidence-references",
);

type EvidenceReferencesPluginOptions = {
  isEditable?: () => boolean;
  onDocumentChange?: (doc: ProseMirrorNode) => void;
};

export const createEvidenceReferencesPlugin = ({
  isEditable = () => true,
  onDocumentChange,
}: EvidenceReferencesPluginOptions = {}) =>
  new Plugin({
    key: evidenceReferencesKey,
    view(view) {
      onDocumentChange?.(view.state.doc);
      return {
        update(nextView, previousState) {
          if (nextView.state.doc !== previousState.doc) {
            onDocumentChange?.(nextView.state.doc);
          }
        },
      };
    },
    appendTransaction(transactions, _oldState, state) {
      if (
        !isEditable() ||
        !transactions.some((transaction) => transaction.docChanged)
      ) {
        return null;
      }
      const transaction = state.tr;
      for (const { number, positions } of collectEvidenceReferences(state.doc)
        .references) {
        for (const position of positions) {
          const node = state.doc.nodeAt(position);
          if (node === null) {
            panic(
              "An evidence position must resolve in the document it was collected from",
            );
          }
          const field = readEvidenceField(node);
          if (
            field.type === "reference" &&
            field.displayText !== evidenceLabel(number)
          ) {
            transaction.setNodeAttribute(
              position,
              "displayText",
              evidenceLabel(number),
            );
          }
        }
      }
      return transaction.docChanged ? transaction : null;
    },
  });
