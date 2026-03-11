import type I18nMessages from "@/i18n/langs/messages.gen";

declare module "use-intl" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface AppConfig {
    Messages: I18nMessages;
  }
}
