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

import { renderComposite, resolvePath } from "@stll/template-conditions";

import { arrayOrEmpty } from "@/api/lib/array";
import { isRecord } from "@/api/lib/type-guards";

import {
  mapRepeatablePath,
  readRowSubPath,
  writeRowSubPath,
} from "./repeatable-paths";
import type { FieldMeta, FieldPart, RichPatchValue } from "./types";

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
 *  part key are left as-is (a visible authoring artifact, not user error).
 *  Routes through the canonical `renderComposite` in @stll/template-conditions
 *  (the single source of truth shared with the web preview); the declared
 *  parts are exactly the supplied value keys, so a marker is substituted iff a
 *  value exists for it. */
export const renderCompositeFormat = (
  format: string,
  partValues: Readonly<Record<string, string>>,
): string =>
  renderComposite(
    Object.keys(partValues).map((key) => ({ key })),
    format,
    partValues,
  );

/** Replace the value at `path` where {@link resolvePath} found it: the exact
 *  flat dotted key when present, otherwise the nested leaf. Shared with the
 *  registry-lookup resolution (lookup-fields.ts), which rewrites values the
 *  same way. */
export const replaceResolvedValue = (
  values: Record<string, unknown>,
  path: string,
  value: RichPatchValue,
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
 * Validate one composite value (the object of part values for a single field
 * or one loop row) and render it through the field's format. Pushes
 * field-named errors and returns the rendered string, or null when the value
 * is absent/a string (passes through) or failed validation (so the caller
 * leaves it unchanged).
 */
const assembleCompositeValue = ({
  path,
  parts,
  format,
  incoming,
  errors,
}: {
  path: string;
  parts: readonly FieldPart[];
  format: string;
  incoming: unknown;
  errors: CompositeFieldError[];
}): string | null => {
  if (incoming === undefined || typeof incoming === "string") {
    return null;
  }
  if (!isRecord(incoming)) {
    errors.push({
      path,
      partKey: null,
      message: `Field "${path}": expected an object of part values or a string.`,
    });
    return null;
  }

  const partKeys = new Set(parts.map((part) => part.key));
  const partValues: Record<string, string> = {};
  let fieldValid = true;

  for (const key of Object.keys(incoming)) {
    if (!partKeys.has(key)) {
      errors.push({
        path,
        partKey: key,
        message: `Field "${path}": unknown part "${key}".`,
      });
      fieldValid = false;
    }
  }

  for (const part of parts) {
    const raw = incoming[part.key];
    const error = validatePart(path, part, raw);
    if (error) {
      errors.push(error);
      fieldValid = false;
      continue;
    }
    if (typeof raw === "string") {
      partValues[part.key] = raw;
    }
  }

  if (!fieldValid) {
    return null;
  }
  return renderCompositeFormat(format, partValues);
};

/**
 * Assemble composite field values: for every manifest field with
 * `parts` + `format` whose incoming value is an object of part values,
 * validate each part and replace the object with the rendered string.
 * A plain string value passes through unchanged (backward compatible);
 * an absent value is left for the fill's unmatched diagnostics.
 *
 * A composite field inside an `{{#each}}` loop keeps a dotted path
 * (`parties.signer`) while the value is an array of rows
 * (`parties: [{ signer: { title, name } }]`); the direct `resolvePath` then
 * returns undefined, so each row's sub-path object is assembled in place
 * (see {@link mapRepeatablePath}) and the loop expander flattens the rendered
 * string under `__each_<container>_<idx>_<leaf>`.
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
    const parts = arrayOrEmpty(field.parts);
    const format = field.format;
    if (format === undefined) {
      continue;
    }
    const incoming = resolvePath(field.path, resolved);
    if (incoming === undefined) {
      mapRepeatablePath(resolved, field.path, ({ row, subPath }) => {
        const rendered = assembleCompositeValue({
          path: field.path,
          parts,
          format,
          incoming: readRowSubPath(row, subPath),
          errors,
        });
        if (rendered !== null) {
          writeRowSubPath(row, subPath, rendered);
        }
      });
      continue;
    }
    const rendered = assembleCompositeValue({
      path: field.path,
      parts,
      format,
      incoming,
      errors,
    });
    if (rendered !== null) {
      replaceResolvedValue(resolved, field.path, rendered);
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
