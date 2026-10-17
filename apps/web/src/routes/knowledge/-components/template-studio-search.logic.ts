import { isSafeFieldPath } from "@stll/template-conditions";
import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

import { sanitizeFieldPath } from "@/routes/knowledge/-components/template-studio-model";
import type { StudioField } from "@/routes/knowledge/-components/template-studio-store";

export const SLASH_MENU_MAX_FIELDS = 50;
export const MAX_TAG_SUGGESTIONS = 6;

export type SlashRootItem =
  | { kind: "create-field"; path: string }
  | { kind: "create-condition" }
  | { kind: "field"; path: string; label: string }
  | { kind: "open-fields" }
  | { kind: "open-clauses" };

const createFieldPathFromQuery = (trimmed: string): string => {
  if (trimmed === "") {
    return "field";
  }
  if (isSafeFieldPath(trimmed)) {
    return trimmed;
  }
  const sanitized = sanitizeFieldPath(trimmed);
  return isSafeFieldPath(sanitized) ? sanitized : "field";
};

const uniqueFieldPath = (base: string, fields: StudioField[]): string => {
  let path = base;
  for (let n = 2; fields.some((field) => field.path === path); n++) {
    path = `${base}_${n}`;
  }
  return path;
};

export const matchingSlashFields = (
  query: string,
  fields: StudioField[],
): StudioField[] => {
  const needle = query.trim().toLowerCase();
  const matches = (field: StudioField): boolean => {
    if (needle === "") {
      return true;
    }
    const label = field.label === "" ? field.path : field.label;
    return (
      containsSearchMatchKey(field.path.toLowerCase(), needle) ||
      containsSearchMatchKey(label.toLowerCase(), needle)
    );
  };
  return fields.filter(matches).slice(0, SLASH_MENU_MAX_FIELDS);
};

export const buildSlashRootItems = (
  query: string,
  fields: StudioField[],
): SlashRootItem[] => {
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const matches = (...keywords: string[]): boolean =>
    keywords.some((keyword) => containsSearchMatchKey(keyword, needle));

  if (trimmed === "") {
    const items: SlashRootItem[] = [
      { kind: "create-field", path: uniqueFieldPath("field", fields) },
      { kind: "create-condition" },
    ];
    if (fields.length > 0) {
      items.push({ kind: "open-fields" });
    }
    items.push({ kind: "open-clauses" });
    return items;
  }

  const createPath = createFieldPathFromQuery(trimmed);
  const reuseExact = fields.some((field) => field.path === createPath);
  const items: SlashRootItem[] = matchingSlashFields(query, fields).map(
    (field) => ({
      kind: "field" as const,
      path: field.path,
      label: field.label === "" ? field.path : field.label,
    }),
  );
  if (matches("clause")) {
    items.push({ kind: "open-clauses" });
  }
  if (matches("condition", "if")) {
    items.push({ kind: "create-condition" });
  }
  if (!reuseExact) {
    items.push({ kind: "create-field", path: createPath });
  }
  return items;
};

export const filterTemplateTagSuggestions = (
  suggestions: readonly string[],
  tags: readonly string[],
  input: string,
): string[] =>
  suggestions
    .filter(
      (tag) =>
        !tags.includes(tag) &&
        containsSearchMatchKey(tag.toLowerCase(), input.trim().toLowerCase()),
    )
    .slice(0, MAX_TAG_SUGGESTIONS);
