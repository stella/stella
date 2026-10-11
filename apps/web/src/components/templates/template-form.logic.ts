import { Result } from "better-result";
import * as v from "valibot";

import {
  CLAUSE_WARNINGS_HEADER,
  clauseWarningCountHeaderSchema,
  UNDECIDED_CONDITIONS_HEADER,
  undecidedConditionsHeaderSchema,
} from "@stll/api-contract/template-fill-headers";
import { evaluateCondition } from "@stll/template-conditions";

import type {
  NamedCondition,
  ResolvedField,
} from "@/components/templates/template-discover-types";
import { optionalArray } from "@/lib/arrays";

const aiFieldErrorPathsSchema = v.array(
  v.object({ fieldPath: v.pipe(v.string(), v.nonEmpty()) }),
);

/** Decode the download diagnostics without trusting the HTTP header shape. */
export const readAiFieldErrorPaths = (headers: Headers) =>
  Result.try(() => {
    const encoded = headers.get("X-Ai-Field-Errors");
    if (encoded === null) {
      return [];
    }
    const decoded: unknown = JSON.parse(decodeURIComponent(encoded));
    return v
      .parse(aiFieldErrorPathsSchema, decoded)
      .map(({ fieldPath }) => fieldPath);
  });

/** How a warning names an undecided condition: its label, or its path when
 *  the template authored an empty label. */
const undecidedConditionName = ({
  label,
  path,
}: {
  label: string;
  path: string;
}): string => (label === "" ? path : label);

/** The labels of the AI-decided conditions a download left undecided. */
export const readUndecidedConditionLabels = (headers: Headers) =>
  Result.try(() => {
    const encoded = headers.get(UNDECIDED_CONDITIONS_HEADER);
    if (encoded === null) {
      return [];
    }
    const decoded: unknown = JSON.parse(decodeURIComponent(encoded));
    return v
      .parse(undecidedConditionsHeaderSchema, decoded)
      .map(undecidedConditionName);
  });

/** What a fill saved into a matter reports back, as far as the notices read
 *  it. */
type SavedFill = {
  completionStatus: "complete" | "partial";
  unmatchedPlaceholders: readonly string[];
  aiFieldErrors: readonly { fieldPath: string }[];
  undecidedConditions: readonly { label: string; path: string }[];
  structureErrors: readonly unknown[];
};

/** One notice the save-to-matter flow shows, in display order. */
export type SavedFillNotice =
  | { kind: "created" }
  | { kind: "createdIncomplete" }
  | { kind: "unmatchedPlaceholders"; list: string }
  | { kind: "aiFieldsNotDrafted"; list: string }
  | { kind: "aiConditionsUndecided"; list: string }
  | { kind: "structureErrors"; count: number };

/**
 * The notices for a fill saved into a matter. The document is reported as
 * created only when the server graded the fill complete; a partial fill is
 * reported as incomplete, followed by every reason it fell short.
 */
export const savedFillNotices = (created: SavedFill): SavedFillNotice[] => [
  created.completionStatus === "complete"
    ? { kind: "created" }
    : { kind: "createdIncomplete" },
  ...(created.unmatchedPlaceholders.length === 0
    ? []
    : [
        {
          kind: "unmatchedPlaceholders" as const,
          list: created.unmatchedPlaceholders.join(", "),
        },
      ]),
  // A field whose draft failed is unfilled, so it is already listed above
  // as an unmatched placeholder; this names the ones the model could not
  // write, which the person filling the template has to write instead.
  ...(created.aiFieldErrors.length === 0
    ? []
    : [
        {
          kind: "aiFieldsNotDrafted" as const,
          list: created.aiFieldErrors
            .map((fieldError) => fieldError.fieldPath)
            .join(", "),
        },
      ]),
  // A condition nothing decided rendered its sections as if it did not
  // apply; the person filling the template has to decide it instead.
  ...(created.undecidedConditions.length === 0
    ? []
    : [
        {
          kind: "aiConditionsUndecided" as const,
          list: created.undecidedConditions
            .map(undecidedConditionName)
            .join(", "),
        },
      ]),
  ...(created.structureErrors.length === 0
    ? []
    : [
        {
          kind: "structureErrors" as const,
          count: created.structureErrors.length,
        },
      ]),
];

type SingleFlightState = {
  current: Promise<void> | null;
};

/**
 * Run one leading operation and share it with every concurrent caller.
 * A new operation may start only after the active promise settles.
 */
export const runLeadingSingleFlight = async (
  state: SingleFlightState,
  operation: () => Promise<void>,
): Promise<void> => {
  if (state.current !== null) {
    await state.current;
    return;
  }

  const current = operation().finally(() => {
    if (state.current === current) {
      state.current = null;
    }
  });
  state.current = current;
  await current;
};

// ── Fill-form grouping ───────────────────────────────────

/**
 * One block of the fill form. A dotted path is how an author says "these
 * belong together", so its fields render inside one titled fieldset; every
 * other field sits in the single ungrouped block.
 */
export type FieldGroup =
  | { kind: "ungrouped"; fields: ResolvedField[] }
  | {
      kind: "named";
      prefix: string;
      legend: string;
      fields: ResolvedField[];
      /** The fields under the prefix, without the parent field itself.
       *  Registry autofill maps a path's LAST segment onto a company
       *  attribute, so a parent named `seat` would be filled with the address
       *  that belongs to `seat.street`. */
      children: ResolvedField[];
    };

const UNGROUPED = "";

const dottedPrefix = (path: string): string => {
  const dotIndex = path.indexOf(".");
  return dotIndex > 0 ? path.slice(0, dotIndex) : UNGROUPED;
};

/**
 * Group scalar fields by the first segment of their dotted path, in the order
 * the template declares them. The heading is the parent field's label when the
 * template fills the prefix itself, else the authored prefix; both are
 * authored data, so neither is translated.
 */
export const groupFieldsByPrefix = (
  fields: readonly ResolvedField[],
): FieldGroup[] => {
  const prefixes = new Set(fields.map((field) => dottedPrefix(field.path)));
  prefixes.delete(UNGROUPED);

  const members = new Map<string, ResolvedField[]>();
  const parentLabels = new Map<string, string>();

  for (const field of fields) {
    // A field at the prefix itself (`landlord` beside `landlord.name`) heads
    // its own group instead of drifting in among the ungrouped fields.
    const isParent = prefixes.has(field.path);
    const label = field.label?.trim() ?? "";
    if (isParent && label !== "") {
      parentLabels.set(field.path, label);
    }
    const key = isParent ? field.path : dottedPrefix(field.path);
    const existing = members.get(key);
    if (existing) {
      existing.push(field);
    } else {
      members.set(key, [field]);
    }
  }

  return [...members].map(([prefix, groupFields]) =>
    prefix === UNGROUPED
      ? { kind: "ungrouped", fields: groupFields }
      : {
          kind: "named",
          prefix,
          legend: parentLabels.get(prefix) ?? prefix,
          fields: groupFields,
          children: groupFields.filter((field) => field.path !== prefix),
        },
  );
};

export const readClauseWarnings = (headers: Headers) =>
  Result.try(() =>
    v.parse(
      clauseWarningCountHeaderSchema,
      headers.get(CLAUSE_WARNINGS_HEADER) ?? "0",
    ),
  );

/**
 * The values an item field's `visibleWhen` reads for one item, as the fill
 * evaluates a condition inside that loop iteration: the item's fields under
 * the array path and every loop alias, its non-empty fields under their bare
 * names (an iteration reads its own item first), and the loop counters.
 */
const itemConditionValues = (
  field: ResolvedField,
  index: number,
  itemCount: number,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const scoped = new Map<string, unknown>(
    Object.entries({
      ...values,
      "loop.index": index + 1,
      "loop.index0": index,
      "loop.first": index === 0,
      "loop.last": index === itemCount - 1,
      "loop.length": itemCount,
    }),
  );
  for (const sub of optionalArray(field.itemFields)) {
    const value = values[`${field.path}[${String(index)}].${sub.path}`];
    for (const head of [field.path, ...optionalArray(field.itemAliases)]) {
      scoped.set(`${head}.${sub.path}`, value);
    }
    if (value !== undefined && value !== "") {
      scoped.set(sub.path, value);
    }
  }
  return Object.fromEntries(scoped);
};

/** The item fields the form asks for on item `index`: those whose
 *  `visibleWhen` holds for that item. A field the item's branch prunes is
 *  never rendered for it, so it is neither shown nor required. */
export const visibleItemFields = ({
  field,
  index,
  itemCount,
  values,
  conditions,
}: {
  field: ResolvedField;
  index: number;
  itemCount: number;
  values: Readonly<Record<string, unknown>>;
  conditions: readonly NamedCondition[];
}): ResolvedField[] =>
  optionalArray(field.itemFields).filter(
    (sub) =>
      sub.visibleWhen === undefined ||
      evaluateCondition(
        sub.visibleWhen,
        itemConditionValues(field, index, itemCount, values),
        conditions,
      ),
  );
