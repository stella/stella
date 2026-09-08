import { Result } from "better-result";
import * as v from "valibot";

import type { ResolvedField } from "@/components/templates/template-discover-types";

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
