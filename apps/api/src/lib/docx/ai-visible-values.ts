import { isSafeFieldPath } from "@stll/template-conditions";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

import type { FieldMeta } from "./types";

type OmitSourceBoundValuesOptions = {
  values: Record<string, unknown>;
  fields: readonly FieldMeta[];
  scopePath?: string | undefined;
};

export const omitSourceBoundValues = ({
  values,
  fields,
  scopePath,
}: OmitSourceBoundValuesOptions): Record<string, unknown> => {
  const scopePrefix = scopePath === undefined ? undefined : `${scopePath}.`;
  const hiddenPaths = fields
    .filter((field) => field.source !== undefined)
    .flatMap((field) => {
      if (scopePath === undefined) {
        return [field.path];
      }
      if (field.path === scopePath) {
        return [""];
      }
      return scopePrefix !== undefined && field.path.startsWith(scopePrefix)
        ? [field.path.slice(scopePrefix.length)]
        : [];
    });
  if (hiddenPaths.length === 0) {
    return values;
  }

  let visible = { ...values };
  for (const path of hiddenPaths) {
    if (path === "") {
      return {};
    }
    visible = omitKey(visible, path);
    if (isSafeFieldPath(path)) {
      visible = deleteNestedPath(visible, path.split("."), 0);
    }
  }
  return visible;
};

const deleteNestedPath = (
  values: Record<string, unknown>,
  segments: readonly string[],
  index: number,
): Record<string, unknown> => {
  const segment = segments[index];
  if (segment === undefined) {
    return { ...values };
  }

  if (index === segments.length - 1) {
    return omitKey(values, segment);
  }

  const next = values[segment];
  if (isUnknownArray(next)) {
    return {
      ...values,
      [segment]: next.map((item) =>
        isRecord(item) ? deleteNestedPath(item, segments, index + 1) : item,
      ),
    };
  }
  if (isRecord(next)) {
    return {
      ...values,
      [segment]: deleteNestedPath(next, segments, index + 1),
    };
  }
  return { ...values };
};

const omitKey = (
  values: Record<string, unknown>,
  omittedKey: string,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== omittedKey),
  );
