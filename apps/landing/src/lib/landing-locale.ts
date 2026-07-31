const LANDING_LOCALE_PREFERENCE_KEY = "stella:landing-locale";
const DEFAULT_LANDING_LOCALE = "en";

type LocalizedLandingRoute = {
  locale: string;
  path: string;
};

const matchBrowserRoute = (
  browserLanguages: readonly string[],
  localizedRoutes: readonly LocalizedLandingRoute[],
): LocalizedLandingRoute | undefined => {
  const normalizedRoutes = localizedRoutes.map((route) => ({
    route,
    tag: route.locale.toLowerCase(),
  }));

  for (const language of browserLanguages) {
    const normalizedLanguage = language.trim().toLowerCase();
    const exact = normalizedRoutes.find(
      ({ tag }) => tag === normalizedLanguage,
    );
    if (exact !== undefined) {
      return exact.route;
    }

    const primaryLanguage = normalizedLanguage.split("-").at(0);
    const regionalMatch = normalizedRoutes.find(
      ({ tag }) => tag.split("-").at(0) === primaryLanguage,
    );
    if (regionalMatch !== undefined) {
      return regionalMatch.route;
    }
  }

  return localizedRoutes.find(
    ({ locale }) => locale === DEFAULT_LANDING_LOCALE,
  );
};

type LandingLocaleRedirectOptions = {
  browserLanguages: readonly string[];
  currentLocale: string;
  hash: string;
  localizedRoutes: readonly LocalizedLandingRoute[];
  savedLocale: string | null;
  search: string;
};

export const resolveLandingLocaleRedirect = ({
  browserLanguages,
  currentLocale,
  hash,
  localizedRoutes,
  savedLocale,
  search,
}: LandingLocaleRedirectOptions): string | undefined => {
  if (
    localizedRoutes.length === 0 ||
    currentLocale !== DEFAULT_LANDING_LOCALE
  ) {
    return undefined;
  }

  const savedRoute = localizedRoutes.find(
    ({ locale }) => locale === savedLocale,
  );
  const preferredRoute =
    savedRoute ?? matchBrowserRoute(browserLanguages, localizedRoutes);
  if (
    preferredRoute === undefined ||
    preferredRoute.locale === currentLocale
  ) {
    return undefined;
  }

  return `${preferredRoute.path}${search}${hash}`;
};

let isPreferenceListenerRegistered = false;

const persistLandingLocaleChoice = (event: MouseEvent) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const link = event.target.closest<HTMLElement>(
    "[data-landing-locale-choice]",
  );
  const locale = link?.dataset.landingLocaleChoice;
  if (locale !== undefined) {
    window.localStorage.setItem(LANDING_LOCALE_PREFERENCE_KEY, locale);
  }
};

const getLocalizedRoutes = (): LocalizedLandingRoute[] =>
  [
    ...document.querySelectorAll<HTMLLinkElement>(
      'link[rel="alternate"][hreflang]',
    ),
  ].flatMap((link) => {
    const locale = link.hreflang;
    if (locale === "" || locale === "x-default") {
      return [];
    }
    return [{ locale, path: new URL(link.href).pathname }];
  });

export const initializeLandingLocale = () => {
  if (!isPreferenceListenerRegistered) {
    document.addEventListener("click", persistLandingLocaleChoice);
    isPreferenceListenerRegistered = true;
  }

  const currentLocale = document.documentElement.dataset.landingCurrentLocale;
  if (currentLocale === undefined) {
    return;
  }

  const browserLanguages =
    navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  const destination = resolveLandingLocaleRedirect({
    browserLanguages,
    currentLocale,
    hash: window.location.hash,
    localizedRoutes: getLocalizedRoutes(),
    savedLocale: window.localStorage.getItem(LANDING_LOCALE_PREFERENCE_KEY),
    search: window.location.search,
  });
  if (destination !== undefined) {
    window.location.replace(destination);
  }
};
