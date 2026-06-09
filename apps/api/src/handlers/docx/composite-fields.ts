/**
 * Composite (multipart) field assembly.
 *
 * A manifest field with `parts` + `format` is filled as several parts (e.g. a
 * select for a professional title plus a free-text name) that are validated
 * and joined into the single string the document's one {{marker}} carries:
 * format "{{position}} {{name}}" renders "rad. praw. Jan Kowalski".
 *
 * Pure: no IO, no model/provider dependency. The fill boundary calls
 * {@link resolveCompositeFields} on the incoming values before substitution
 * and rejects the request when any part fails validation.
 */

import { markerPattern, resolvePath } from "@stll/template-conditions";

import { isRecord } from "@/api/lib/type-guards";

import type { FieldMeta, FieldPart } from "./types";

export type CompositeFieldError = {
  /** Manifest path of the composite field. */
  path: string;
  /** Offending part key; null when the field's value as a whole is invalid. */
  partKey: string | null;
  message: string;
};

export type CompositeResolution =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: CompositeFieldError[] };

const validatePart = (
  path: string,
  part: FieldPart,
  raw: unknown,
): CompositeFieldError | null => {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      path,
      partKey: part.key,
      message: `Field "${path}": missing value for part "${part.key}".`,
    };
  }

  if (
    part.inputType === "select" &&
    part.options !== undefined &&
    part.options.length > 0 &&
    !part.options.includes(raw)
  ) {
    return {
      path,
      partKey: part.key,
      message:
        `Field "${path}": part "${part.key}" must be one of: ` +
        `${part.options.join(", ")}.`,
    };
  }

  if (part.pattern !== undefined && part.pattern !== "") {
    // Anchor so the pattern must describe the whole part value. An invalid
    // pattern in the manifest is skipped, mirroring the fill form.
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${part.pattern})$`, "u");
    } catch {
      return null;
    }
    if (!re.test(raw)) {
      return {
        path,
        partKey: part.key,
        message: `Field "${path}": part "${part.key}" does not match the expected format.`,
      };
    }
  }

  return null;
};

/** Render a `{{key}}` format over part values. Markers without a matching
 *  part key are left as-is (a visible authoring artifact, not user error). */
export const renderCompositeFormat = (
  format: string,
  partValues: Readonly<Record<string, string>>,
): string =>
  format.replace(
    markerPattern(),
    (raw, inner: string) => partValues[inner.trim()] ?? raw,
  );

/** Replace the value at `path` where {@link resolvePath} found it: the exact
 *  flat dotted key when present, otherwise the nested leaf. Shared with the
 *  registry-lookup resolution (lookup-fields.ts), which rewrites values the
 *  same way. */
export const replaceResolvedValue = (
  values: Record<string, unknown>,
  path: string,
  value: string,
): void => {
  if (Object.hasOwn(values, path)) {
    values[path] = value;
    return;
  }
  const segments = path.split(".");
  let current: Record<string, unknown> = values;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) {
      return;
    }
    current = next;
  }
  const leaf = segments.at(-1);
  if (leaf !== undefined) {
    current[leaf] = value;
  }
};

/**
 * Assemble composite field values: for every manifest field with
 * `parts` + `format` whose incoming value is an object of part values,
 * validate each part and replace the object with the rendered string.
 * A plain string value passes through unchanged (backward compatible);
 * an absent value is left for the fill's unmatched diagnostics.
 */
export const resolveCompositeFields = ({
  values,
  fields,
}: {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
}): CompositeResolution => {
  const compositeFields = fields.filter(
    (field) => field.parts !== undefined && field.format !== undefined,
  );
  if (compositeFields.length === 0) {
    return { ok: true, values };
  }

  const resolved: Record<string, unknown> = { ...values };
  const errors: CompositeFieldError[] = [];

  for (const field of compositeFields) {
    const incoming = resolvePath(field.path, resolved);
    if (incoming === undefined || typeof incoming === "string") {
      continue;
    }
    if (!isRecord(incoming)) {
      errors.push({
        path: field.path,
        partKey: null,
        message: `Field "${field.path}": expected an object of part values or a string.`,
      });
      continue;
    }

    const parts = field.parts ?? [];
    const partKeys = new Set(parts.map((part) => part.key));
    const partValues: Record<string, string> = {};
    let fieldValid = true;

    for (const key of Object.keys(incoming)) {
      if (!partKeys.has(key)) {
        errors.push({
          path: field.path,
          partKey: key,
          message: `Field "${field.path}": unknown part "${key}".`,
        });
        fieldValid = false;
      }
    }

    for (const part of parts) {
      const raw = incoming[part.key];
      const error = validatePart(field.path, part, raw);
      if (error) {
        errors.push(error);
        fieldValid = false;
        continue;
      }
      if (typeof raw === "string") {
        partValues[part.key] = raw;
      }
    }

    if (fieldValid && field.format !== undefined) {
      replaceResolvedValue(
        resolved,
        field.path,
        renderCompositeFormat(field.format, partValues),
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, values: resolved };
};

/**
 * Boundary convenience for the fill handlers: assemble composite values in
 * place and return the combined validation message, or null when everything
 * assembled (or there is no manifest).
 */
export const applyCompositeFields = (
  values: Record<string, unknown>,
  manifest: { fields: FieldMeta[] } | null,
): string | null => {
  if (!manifest) {
    return null;
  }
  const composite = resolveCompositeFields({
    values,
    fields: manifest.fields,
  });
  if (!composite.ok) {
    return composite.errors.map((e) => e.message).join(" ");
  }
  for (const [key, value] of Object.entries(composite.values)) {
    values[key] = value;
  }
  return null;
};
