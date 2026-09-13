import type { CaseLawResearchAnswerType } from "@stll/api-contract";

import { VALUE_TYPE_META } from "@/lib/value-types";
import type { ValueTypeKind } from "@/lib/value-types";

/**
 * Which canonical value kind each answer takes.
 *
 * The matter table's column composer names its answer kinds from the same
 * registry, so "Yes / No" and "Text" read and look identical on both tables:
 * one extraction engine, one vocabulary, one icon per kind.
 */
const ANSWER_TYPE_VALUE_KIND = {
  yes_no: "boolean",
  text: "text",
} as const satisfies Record<CaseLawResearchAnswerType, ValueTypeKind>;

/**
 * The return type is inferred, never annotated as `ValueTypeMeta`: the wide
 * alias types `labelKey` as the whole `TranslationKey` union, which blows past
 * the checker's union budget the moment `t()` is handed one.
 */
export const answerTypeMeta = (answerType: CaseLawResearchAnswerType) =>
  VALUE_TYPE_META[ANSWER_TYPE_VALUE_KIND[answerType]];
