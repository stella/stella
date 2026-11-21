import type { UiLocale } from "@stll/locales";

import type { MobileMessages } from "./catalogs";

// Types every `useTranslations` key against the English catalogue, so a
// missing or stale key fails typecheck where it is used.
declare module "use-intl" {
  interface AppConfig {
    Locale: UiLocale;
    Messages: MobileMessages;
  }
}
