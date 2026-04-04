import type { getTranslator } from "@/i18n/i18n-store";

type AppTranslator = ReturnType<typeof getTranslator>;

export type TranslationKey = Parameters<AppTranslator>[0];
