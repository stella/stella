import type I18nMessages from "../i18n/langs/messages.gen";

declare module "use-intl" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: interface required for declaration merging
  interface AppConfig {
    Messages: I18nMessages;
  }
}
