import type { getTranslator } from "@/i18n/i18n-store";

export type TranslationKey = Parameters<ReturnType<typeof getTranslator>>[0];
