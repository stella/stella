import type { TranslationKey } from "@/i18n/types";

/** Lifecycle values the corpus constrains `legislation_documents.status` to. */
export const STATUTE_STATUSES = [
  "current",
  "historical",
  "repealed",
  "draft",
] as const;

export type StatuteStatus = (typeof STATUTE_STATUSES)[number];

export const STATUTE_STATUS_LABEL_KEYS = {
  current: "statutes.status.current",
  draft: "statutes.status.draft",
  historical: "statutes.status.historical",
  repealed: "statutes.status.repealed",
} as const satisfies Record<StatuteStatus, TranslationKey>;

export const isStatuteStatus = (value: string): value is StatuteStatus =>
  Object.hasOwn(STATUTE_STATUS_LABEL_KEYS, value);
