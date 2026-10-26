import type { getTranslator } from "@/i18n/translator";

export type TranslationKey = Parameters<ReturnType<typeof getTranslator>>[0];
