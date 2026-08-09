import type { ReactNode } from "react";

import type { LocaleMessages } from "@/i18n/i18n-store";
import type I18nMessages from "@/i18n/langs/messages.gen";

type LocalizedIntlProviderProps = {
  children: ReactNode;
  locale: string;
  messages: LocaleMessages;
  timeZone?: string;
};

declare module "use-intl" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- module augmentation requires interface merging
  interface AppConfig {
    Messages: I18nMessages;
  }

  // AppConfig.Messages intentionally keeps the source-language literals so
  // useTranslations can infer ICU arguments. At runtime, IntlProvider accepts
  // the same total catalog shape with localized string leaves.
  function IntlProvider(props: LocalizedIntlProviderProps): React.JSX.Element;
}
