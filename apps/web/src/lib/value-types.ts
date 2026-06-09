/**
 * Canonical value types — one name + one icon per kind of value, everywhere.
 *
 * Template fields (Studio / wizard / fill form) and matter-table properties
 * describe overlapping kinds of values (text, numbers, dates, tags) but grew
 * separate names and icons. This registry is the single source both surfaces
 * render from, so a "Tag" looks and reads the same whether it's an extracted
 * property or a template field. Kinds that exist on one surface only
 * (multiline text, yes/no, multi-tags) still live here so any new surface
 * starts consistent.
 */

import {
  AlignLeftIcon,
  CalendarIcon,
  CircleDotIcon,
  HashIcon,
  TagsIcon,
  TextIcon,
  ToggleLeftIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { TranslationKey } from "@/i18n/types";

export type ValueTypeKind =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "date"
  | "select"
  | "multiSelect";

export type ValueTypeMeta = {
  icon: LucideIcon;
  labelKey: TranslationKey;
};

// Label keys reuse the surfaces' existing canonical strings (single
// translation per word — the i18n gate enforces it): the table's property
// chips for the shared kinds, the template input-type names for the
// template-only ones.
export const VALUE_TYPE_META = {
  text: { icon: AlignLeftIcon, labelKey: "workspaces.properties.chipText" },
  textarea: { icon: TextIcon, labelKey: "templates.inputTypes.textarea" },
  number: { icon: HashIcon, labelKey: "workspaces.properties.chipNumber" },
  boolean: { icon: ToggleLeftIcon, labelKey: "templates.inputTypes.boolean" },
  date: { icon: CalendarIcon, labelKey: "common.date" },
  select: { icon: CircleDotIcon, labelKey: "workspaces.properties.chipSingle" },
  multiSelect: { icon: TagsIcon, labelKey: "workspaces.properties.chipMulti" },
} as const satisfies Record<ValueTypeKind, ValueTypeMeta>;

/** Narrows opaque strings (e.g., from `AISuggestion.display.valueKind`)
 *  to registry keys; unknown strings render no chip. */
export const isValueTypeKind = (value: string): value is ValueTypeKind =>
  Object.hasOwn(VALUE_TYPE_META, value);

/** Template field input types map 1:1 onto value kinds. */
export const inputTypeValueKind = (
  inputType: "text" | "textarea" | "number" | "boolean" | "date" | "select",
): ValueTypeKind => inputType;

/** Matter-property content types → value kinds. */
const CONTENT_TYPE_KIND = {
  text: "text",
  int: "number",
  date: "date",
  "single-select": "select",
  "multi-select": "multiSelect",
} as const satisfies Record<string, ValueTypeKind>;

export const contentTypeValueKind = (
  contentType: keyof typeof CONTENT_TYPE_KIND,
): ValueTypeKind => CONTENT_TYPE_KIND[contentType];
