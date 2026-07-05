/**
 * Resolve AI-fillable template fields.
 *
 * A manifest field with an `aiPrompt` has its value drafted by a model at fill
 * time (e.g. "the scope of this power of attorney"). This mirrors formula
 * fields, but the value comes from an injected generator rather than
 * arithmetic — keeping this module free of any model/provider dependency so it
 * stays pure and testable. The fill boundary supplies the generator (wired to
 * the org's model); with no generator, AI fields are left unfilled.
 *
 * A value the user actually supplied always wins over the AI draft.
 *
 * Array-scoped fields: when a field's dotted path crosses an array (e.g.
 * `contracts.summary` where `contracts` resolves to an array of objects), the
 * flat draft would be orphaned — `{{#each}}` expansion rewrites the placeholder
 * to a synthetic per-row key sourced from the row object, so a value under the
 * flat path never reaches the loop. Instead we draft one value per row and
 * write it ONTO the row object at the remainder path, where
 * `registerItemPatchValues` picks it up natively with no loop-engine change.
 */

import { resolvePath } from "@stll/template-conditions";

import { isRecord } from "@/api/lib/type-guards";

import type { FieldMeta } from "./types";

export type AiFieldGenerator = (input: {
  prompt: string;
  fieldPath: string;
  /** Already-entered + previously-resolved values, for grounding the draft.
   *  For an array-scoped (per-item) field this is the single row object, not
   *  the whole data object, so the draft is grounded in that item alone. */
  values: Record<string, unknown>;
  /** Rendered document text, supplied only for fields that opted in via
   *  {@link FieldMeta.aiSeesDocument}; undefined keeps the prompt unchanged. */
  documentText?: string | undefined;
  /** Positional context for an array-scoped (per-item) draft: the row's
   *  1-based index and the total row count. Absent for top-level fields. */
  item?: { index: number; count: number } | undefined;
}) => Promise<string | undefined>;

/** Rows of a single array level are drafted in parallel (no sequential
 *  dependency, unlike top-level fields). Bounded so a large view cannot fan out
 *  an unbounded burst of metered model calls. */
const AI_FIELD_ITEM_CONCURRENCY = 4;

export const resolveAiFields = async ({
  values,
  fields,
  generate,
  documentText,
}: {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
  generate: AiFieldGenerator | undefined;
  /** Rendered document body, injected into the generator prompt only for
   *  fields with {@link FieldMeta.aiSeesDocument} set. */
  documentText?: string | undefined;
}): Promise<Record<string, unknown>> => {
  // A boolean field with an aiPrompt is a yes/no decision, not a string draft;
  // it is resolved to a real boolean by resolveAiConditions instead, so it is
  // excluded here.
  const aiFields = fields.filter(
    (field) =>
      field.aiPrompt !== undefined &&
      field.aiPrompt !== "" &&
      field.inputType !== "boolean",
  );
  if (generate === undefined || aiFields.length === 0) {
    return values;
  }

  const resolved: Record<string, unknown> = { ...values };
  // Iterate in declaration order so the top-level chain keeps its sequential
  // dependency (each top-level draft sees prior drafts via `resolved`). An
  // array-scoped field is awaited at its position too, but fans its rows out
  // internally with bounded concurrency.
  for (const field of aiFields) {
    const prompt = field.aiPrompt;
    if (prompt === undefined) {
      continue;
    }
    const docText = field.aiSeesDocument === true ? documentText : undefined;

    const boundary = findArrayBoundary(field.path, resolved);
    if (boundary !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- awaited at its position to preserve declaration order; rows fan out internally
      await resolveArrayField({
        rows: boundary.rows,
        remainder: boundary.remainder,
        fieldPath: field.path,
        prompt,
        documentText: docText,
        generate,
      });
      continue;
    }

    // Top-level field: existing sequential behaviour, unchanged. The fill form
    // nests dotted paths (`company.name` -> `{ company: { name }}`), so resolve
    // the path rather than reading the flat key — otherwise a nested user value
    // is missed and the AI draft overwrites it.
    const existing = resolvePath(field.path, resolved);
    if (existing !== undefined && existing !== "") {
      continue; // user-entered value wins
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential: metered AI draft call that reads the shared `resolved` accumulator each iteration; must not fan out
    const value = await generate({
      prompt,
      fieldPath: field.path,
      values: resolved,
      // Only opted-in fields pay the token cost of the document context; the
      // generator omits the section entirely when this is undefined.
      documentText: docText,
    });
    if (value !== undefined) {
      resolved[field.path] = value;
    }
  }
  return resolved;
};

type ArrayBoundary = {
  /** Object rows of the (single) array the path crosses. */
  rows: Record<string, unknown>[];
  /** Path segment(s) after the array, resolved against each row. */
  remainder: string;
};

/**
 * Find where a dotted path first crosses an array. Returns the array's object
 * rows and the remainder path, or `undefined` when the path resolves to a
 * top-level (non-array) value.
 *
 * The OUTERMOST array wins (shortest prefix), and only object rows participate
 * — a per-item draft is written as a field on the row object.
 */
const findArrayBoundary = (
  path: string,
  data: Record<string, unknown>,
): ArrayBoundary | undefined => {
  const segments = path.split(".");
  // Stop before the last segment: the array must have a remainder to write to.
  for (let i = 1; i < segments.length; i += 1) {
    const value = resolvePath(segments.slice(0, i).join("."), data);
    if (!Array.isArray(value)) {
      continue;
    }
    return {
      rows: value.filter(isRecord),
      remainder: segments.slice(i).join("."),
    };
  }
  return undefined;
};

/** Does the remainder cross a SECOND array on this row (a nested-loop path)? */
const remainderCrossesArray = (
  remainder: string,
  row: Record<string, unknown>,
): boolean => {
  const segments = remainder.split(".");
  for (let i = 1; i < segments.length; i += 1) {
    if (Array.isArray(resolvePath(segments.slice(0, i).join("."), row))) {
      return true;
    }
  }
  return false;
};

/** Write `value` onto `target` at a dotted path, creating intermediate records
 *  so `registerItemPatchValues` flattens it to the same key the placeholder
 *  rewrite expects (`row.party.name` -> `__each_..._party.name`). */
const setNestedPath = (
  target: Record<string, unknown>,
  path: string,
  value: string,
): void => {
  const segments = path.split(".");
  let current = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] ?? "";
    const next = current[segment];
    if (isRecord(next)) {
      current = next;
      continue;
    }
    const created: Record<string, unknown> = {};
    current[segment] = created;
    current = created;
  }
  current[segments.at(-1) ?? ""] = value;
};

/**
 * Draft one value per object row of an array-scoped field, mutating each row at
 * the remainder path. Rows are processed with bounded concurrency; a row whose
 * remainder already holds a non-empty value is skipped (user value wins).
 *
 * v1 supports EXACTLY ONE array level. A path that crosses a second array
 * (`a.b.c` with both `a` and `b` arrays) is skipped entirely — the field is
 * left unfilled — mirroring the module's existing "on failure, leave unfilled"
 * contract (the generator itself swallows model errors and returns undefined).
 */
const resolveArrayField = async ({
  rows,
  remainder,
  fieldPath,
  prompt,
  documentText,
  generate,
}: {
  rows: Record<string, unknown>[];
  remainder: string;
  fieldPath: string;
  prompt: string;
  documentText: string | undefined;
  generate: AiFieldGenerator;
}): Promise<void> => {
  if (rows.some((row) => remainderCrossesArray(remainder, row))) {
    return; // double-array path: unsupported in v1, leave unfilled
  }

  const count = rows.length;
  const pending = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      const existing = resolvePath(remainder, row);
      return existing === undefined || existing === "";
    });
  if (pending.length === 0) {
    return;
  }

  // Bounded worker pool draining a shared queue (mirrors the codebase's
  // reindex pool). A single row's failure surfaces as a swallowed undefined
  // (the generator captures its own model errors); we also guard against a
  // throwing generator so one row can never abort the others.
  const queue = [...pending];
  const workerCount = Math.min(AI_FIELD_ITEM_CONCURRENCY, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (task === undefined) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- bounded-concurrency worker draining a shared queue; the pool runs in parallel
      const value = await draftRow({
        row: task.row,
        index: task.index,
        count,
        fieldPath,
        prompt,
        documentText,
        generate,
      });
      if (value !== undefined) {
        setNestedPath(task.row, remainder, value);
      }
    }
  });
  await Promise.all(workers);
};

/** Generate a single row's draft, treating a thrown generator error as an
 *  unfilled draft (undefined) so it never aborts the sibling rows. */
const draftRow = async ({
  row,
  index,
  count,
  fieldPath,
  prompt,
  documentText,
  generate,
}: {
  row: Record<string, unknown>;
  index: number;
  count: number;
  fieldPath: string;
  prompt: string;
  documentText: string | undefined;
  generate: AiFieldGenerator;
}): Promise<string | undefined> => {
  try {
    return await generate({
      prompt,
      fieldPath,
      values: row,
      documentText,
      item: { index: index + 1, count },
    });
  } catch {
    return undefined;
  }
};
