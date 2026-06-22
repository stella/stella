import type { TranslationKey } from "@/i18n/types";

// Narrow to these specific, parameter-less keys so `t(key)` type-checks with a
// single argument — the broad TranslationKey union also contains placeholder
// keys whose translator overload requires a values argument.
type NativeToolLabelKey = Extract<
  TranslationKey,
  | "catalogue.toolNames.anonymize"
  | "catalogue.toolNames.createDocx"
  | "catalogue.toolNames.webSearch"
>;

// First-party native tools ship English display names in their catalogue
// manifests (a shared, i18n-agnostic package). Map their stable slugs to
// translation keys here so the UI shows a localized name; everything else
// (third-party MCP integrations, user skills, registry adapters like ARES)
// keeps its manifest displayName as-is.
const NATIVE_TOOL_LABEL_KEYS: Record<string, NativeToolLabelKey> = {
  anonymize: "catalogue.toolNames.anonymize",
  "create-docx": "catalogue.toolNames.createDocx",
  "web-search": "catalogue.toolNames.webSearch",
};

export const nativeToolLabelKey = (
  slug: string,
): NativeToolLabelKey | undefined => NATIVE_TOOL_LABEL_KEYS[slug];
