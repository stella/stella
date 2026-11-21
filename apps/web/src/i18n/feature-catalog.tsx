/**
 * Feature catalogs: a feature's own strings, per locale, loaded with the
 * feature's chunk instead of with the app's English bundle.
 *
 * The app's catalog (`langs/*.json`) is imported statically for English, so
 * every string in it is paid for on every cold visit. A feature that loads
 * lazily keeps its strings beside its code instead, under
 * `<feature>/i18n/langs/<locale>.json`, with one top-level namespace that no
 * app catalog uses. `scripts/i18n-feature-catalogs.ts` runs the same checks
 * over every such root as over the app's catalog (source lock, unused keys,
 * lint), and the message census covers them too. See `README.md`.
 */

import { createContext, Suspense, use } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { IntlProvider, useMessages, useTimeZone } from "use-intl";
import { createTranslator } from "use-intl/core";

import { useI18nStore } from "@/i18n/i18n-store";
import type { SupportedLanguage } from "@/i18n/i18n-store";
import { useRenderedMessageLocale } from "@/i18n/provider";

type CatalogMessages = Record<string, Record<string, unknown>>;

type FeatureCatalogProviderProps = {
  /**
   * What renders while the active locale's strings load. Required, so each
   * feature decides it the way its surface decides any other pending state:
   * `null` for a part that mounts beside content already on screen, the
   * surface's pending face otherwise.
   */
  fallback: ReactNode;
  children: ReactNode;
};

/**
 * The app's messages with a feature's namespaces beside them. A namespace the
 * app already uses would silently shadow its strings, so it is refused.
 */
export const mergeFeatureMessages = <TMessages extends CatalogMessages>(
  appMessages: Record<string, unknown>,
  featureMessages: TMessages,
): Record<string, unknown> => {
  for (const namespace of Object.keys(featureMessages)) {
    if (Object.hasOwn(appMessages, namespace)) {
      return panic(
        `Feature catalog namespace "${namespace}" is already an app namespace`,
      );
    }
  }
  return { ...appMessages, ...featureMessages };
};

/**
 * Declares a feature catalog from one loader per locale. Each loader is a
 * dynamic `import()` of that locale's JSON, so the bundler places the strings
 * in the importing feature's chunk; a locale is loaded once, when first used.
 */
export const defineFeatureCatalog = <TMessages extends CatalogMessages>(
  loaders: Readonly<Record<SupportedLanguage, () => Promise<TMessages>>>,
) => {
  const MessagesContext = createContext<TMessages | null>(null);
  const loading = new Map<SupportedLanguage, Promise<TMessages>>();

  // The same promise for every render of a locale, as `use()` requires.
  const load = (lang: SupportedLanguage): Promise<TMessages> => {
    const pending = loading.get(lang);
    if (pending !== undefined) {
      return pending;
    }
    const started = loaders[lang]().catch((error: unknown) => {
      // A failed chunk is asked for again on the next render, not cached.
      loading.delete(lang);
      throw error;
    });
    loading.set(lang, started);
    return started;
  };

  const Loaded = ({ children }: { children: ReactNode }) => {
    const lang = useI18nStore((state) => state.loadedLang);
    const messages = use(load(lang));
    const appMessages = useMessages();
    const locale = useRenderedMessageLocale();
    const timeZone = useTimeZone();
    return (
      <MessagesContext value={messages}>
        <IntlProvider
          locale={locale}
          messages={mergeFeatureMessages(appMessages, messages)}
          timeZone={timeZone}
        >
          {children}
        </IntlProvider>
      </MessagesContext>
    );
  };

  /** Makes the catalog's strings available to everything inside it. */
  const Provider = ({ children, fallback }: FeatureCatalogProviderProps) => (
    <Suspense fallback={fallback}>
      <Loaded>{children}</Loaded>
    </Suspense>
  );

  /**
   * A translator over the catalog's own keys, typed from its English JSON,
   * in the app's locale and time zone.
   */
  const useCatalogTranslations = () => {
    const messages =
      use(MessagesContext) ??
      panic("A feature catalog was read outside its provider");
    const locale = useRenderedMessageLocale();
    const timeZone = useTimeZone();
    return createTranslator({ locale, messages, timeZone });
  };

  return { Provider, useTranslations: useCatalogTranslations, load };
};
