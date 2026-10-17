import { getTranslator, useI18nStore } from "@/i18n/i18n-store";
import type { SupportedLanguage } from "@/i18n/i18n-store";
import { persistPresentationPrefs } from "@/lib/account/presentation-prefs/provider";
import { getAnalytics } from "@/lib/analytics/provider";
import { notifyUserError } from "@/lib/errors/user-toast";

export const setLang = async (lang: SupportedLanguage): Promise<void> => {
  const { authClient } = await import("@/lib/auth-client");
  const session = await authClient.getSession();
  if (session.error) {
    getAnalytics().captureError(session.error);
    notifyUserError(session.error, getTranslator()("errors.actionFailed"));
    return;
  }
  if (session.data) {
    const result = await authClient.updateUser({ locale: lang });
    if (result.error) {
      getAnalytics().captureError(result.error);
      notifyUserError(result.error, getTranslator()("errors.actionFailed"));
      return;
    }
  }
  await useI18nStore.getState().loadMessages(lang);
  if (!session.data && useI18nStore.getState().loadedLang === lang) {
    persistPresentationPrefs(() => ({ visitorLocale: lang }));
  }
};
