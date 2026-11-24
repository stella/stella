import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { readFieldAttrs } from "@stll/folio-core/prosemirror/attrs";
import type { FieldAttrs } from "@stll/folio-core/prosemirror/schema";
import type {
  FolioDerivedFields,
  FolioFieldInsertion,
} from "@stll/folio-react";

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

type EvidenceInstruction =
  | { type: "other" }
  | { type: "invalid" }
  | { type: "reference"; reference: EvidenceReference };

/** What a field instruction says about evidence. */
const readEvidenceInstruction = (instruction: string): EvidenceInstruction => {
  if (!instruction.startsWith(EVIDENCE_INSTRUCTION_PREFIX)) {
    return { type: "other" };
  }
  const decoded = Result.try((): unknown =>
    JSON.parse(
      decodeURIComponent(instruction.slice(EVIDENCE_INSTRUCTION_PREFIX.length)),
    ),
  );
  if (Result.isError(decoded)) {
    return { type: "invalid" };
  }
  const parsed = v.safeParse(evidenceReferenceSchema, decoded.value);
  return parsed.success
    ? { type: "reference", reference: parsed.output }
    : { type: "invalid" };
};

type EvidenceField =
  | { type: "other" }
  | { type: "invalid" }
  | { type: "reference"; reference: EvidenceReference; displayText: string };

const readEvidenceField = (node: ProseMirrorNode): EvidenceField => {
  if (node.type.name !== "field") {
    return { type: "other" };
  }
  const attrs = readFieldAttrs(node);
  if (!attrs.ok) {
    return { type: "other" };
  }
  const read = readEvidenceInstruction(attrs.value.instruction);
  return read.type === "reference"
    ? {
        type: "reference",
        reference: read.reference,
        displayText: attrs.value.displayText,
      }
    : read;
};

const sourceKey = (reference: EvidenceReference) =>
  `${reference.workspaceId}/${reference.entityId}/${reference.entityVersionId}/${reference.fieldId}`;

export const evidenceLabel = (number: number) => `Důkaz ${number}`;

/** The locked field that cites `reference`, as the editor inserts it. */
export const evidenceFieldInsertion = (
  reference: EvidenceReference,
): FolioFieldInsertion => ({
  instruction: `${EVIDENCE_INSTRUCTION_PREFIX}${encodeURIComponent(JSON.stringify(v.parse(evidenceReferenceSchema, reference)))}`,
  displayText: evidenceLabel(1),
  locked: true,
});

export const createEvidenceField = (
  schema: Schema,
  reference: EvidenceReference,
) => {
  const { instruction, displayText } = evidenceFieldInsertion(reference);
  return schema.node("field", {
    fieldType: "UNKNOWN",
    instruction,
    displayText,
    fieldKind: "simple",
    fldLock: true,
    dirty: false,
  } satisfies FieldAttrs);
};

/**
 * Evidence references number their sources by first appearance; every
 * reference to one source shows its number. A field whose instruction does
 * not decode is left as it reads.
 */
export const EVIDENCE_DERIVED_FIELDS: FolioDerivedFields = {
  owns: (instruction) =>
    readEvidenceInstruction(instruction).type === "reference",
  displayTexts: (instructions) => {
    const numbers = new Map<string, number>();
    return instructions.map((instruction) => {
      const read = readEvidenceInstruction(instruction);
      if (read.type !== "reference") {
        return panic("An owned evidence field must decode");
      }
      const key = sourceKey(read.reference);
      const number = numbers.get(key) ?? numbers.size + 1;
      numbers.set(key, number);
      return evidenceLabel(number);
    });
  },
};

export const collectEvidenceReferences = (doc: ProseMirrorNode) => {
  const references: {
    reference: EvidenceReference;
    number: number;
    positions: number[];
  }[] = [];
  const bySource = new Map<string, (typeof references)[number]>();
  const invalidPositions: number[] = [];
  doc.descendants((node, position) => {
    // A tracked deletion or move source is absent from the final pleading,
    // including its descendants; numbering leaves it out alike.
    if (
      node.marks.some(
        (mark) =>
          mark.type.name === "deletion" || mark.type.name === "moveFrom",
      )
    ) {
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

const evidenceReferencesKey = new PluginKey("stella-evidence-references");

/** Reports the document the editor shows each time it changes. */
export const createEvidenceReferencesPlugin = (
  onDocumentChange: (doc: ProseMirrorNode) => void,
) =>
  new Plugin({
    key: evidenceReferencesKey,
    view(view) {
      onDocumentChange(view.state.doc);
      return {
        update(nextView, previousState) {
          if (nextView.state.doc !== previousState.doc) {
            onDocumentChange(nextView.state.doc);
          }
        },
      };
    },
  });
