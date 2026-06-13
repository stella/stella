import type I18nMessages from "../i18n/langs/messages.gen";

declare module "use-intl" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- module augmentation requires interface merging
  interface AppConfig {
    Messages: I18nMessages;
  }
}
