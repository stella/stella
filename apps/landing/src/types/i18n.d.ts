import type Messages from "../i18n/messages/messages.gen";

// Register the generated en message shape with use-intl so translation keys
// and ICU params are type-checked (a typo'd t("...") key fails typecheck).
// Mirrors apps/web/src/types/i18n.d.ts so both surfaces type i18n the same way.
declare module "use-intl" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- module augmentation requires interface merging
  interface AppConfig {
    Messages: Messages;
  }
}
