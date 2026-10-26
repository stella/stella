import type { QueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";

import { resolveUiLocale } from "@stll/locales";

import {
  applyClientDocumentLocale,
  getTranslator,
  loadLocaleMessages,
  useI18nStore,
} from "@/i18n/i18n-store";
import type { LocaleMessages, SupportedLanguage } from "@/i18n/i18n-store";
import { migrateLegacyPresentationPreferences } from "@/i18n/legacy-preferences-migration";
import type { LegacyPresentationMigrationResult } from "@/i18n/legacy-preferences-migration";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import {
  getBrowserPresentationPrefs,
  writeBrowserPresentationPrefs,
} from "@/lib/account/presentation-prefs/provider";
import { getAnalytics } from "@/lib/analytics/provider";
import { fetchSession } from "@/lib/auth-queries";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import { isCurrentDocumentSession } from "@/lib/session-cache-guard";
import { loadAuthContext } from "@/routes/-auth-context";

type DocumentUser = { id: string; locale: string | null } | null;
type DocumentLocaleFingerprint = `${string}:${string}`;

type ClientLocaleOperations = {
  readBootUser: (queryClient: QueryClient) => Promise<DocumentUser>;
  readSelectionUser: () => Promise<DocumentUser>;
  isCurrent: (queryClient: QueryClient, userId: string | null) => boolean;
  getPrefs: () => PresentationPrefs;
  migrate: (args: {
    prefs: PresentationPrefs;
    user: DocumentUser;
    localePriority: "explicit" | "legacy-if-default";
    isCurrent: () => boolean;
  }) => Promise<LegacyPresentationMigrationResult>;
  writePrefs: (patch: Partial<PresentationPrefs>) => Promise<PresentationPrefs>;
  updateProfile: (locale: SupportedLanguage) => Promise<Result<void, unknown>>;
  loadBootMessages: (locale: SupportedLanguage) => Promise<LocaleMessages>;
  applyBoot: (args: {
    locale: SupportedLanguage;
    messages: LocaleMessages;
    prefs: PresentationPrefs;
  }) => void;
  loadSelectedMessages: (
    locale: SupportedLanguage,
    isCurrent: () => boolean,
  ) => Promise<void>;
  loadedLocale: () => SupportedLanguage;
  reportSelectionError: (
    error: unknown,
    fingerprintKey: DocumentLocaleFingerprint,
  ) => void;
};

type Selection =
  | { kind: "none" }
  | { kind: "chosen"; userId: string | null; locale: SupportedLanguage };

/** One document queue owns both profile application and explicit selection. */
export const createClientDocumentLocaleOwner = (
  operations: ClientLocaleOperations,
) => {
  let tail: Promise<void> = Promise.resolve();
  let selection: Selection = { kind: "none" };
  const applied = new WeakMap<QueryClient, string | null>();

  const enqueue = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    // The caller receives failures; the next document action must still run.
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const boot = async (queryClient: QueryClient) =>
    enqueue(async () => {
      const user = await operations.readBootUser(queryClient);
      const userId = user?.id ?? null;
      const current = () => operations.isCurrent(queryClient, userId);
      if (!current()) {
        return operations.getPrefs();
      }
      if (selection.kind === "chosen" && selection.userId !== userId) {
        selection = { kind: "none" };
      }
      if (applied.has(queryClient) && applied.get(queryClient) === userId) {
        return operations.getPrefs();
      }

      const migrated = await operations.migrate({
        prefs: operations.getPrefs(),
        user,
        localePriority:
          selection.kind === "chosen" ? "explicit" : "legacy-if-default",
        isCurrent: current,
      });
      if (!current()) {
        return operations.getPrefs();
      }
      switch (migrated.status) {
        case "profile-error":
          operations.reportSelectionError(migrated.error, "boot:updateUser");
          return operations.getPrefs();
        case "complete":
          break;
        default:
          migrated satisfies never;
          return panic("Unhandled legacy presentation migration result");
      }
      const locale =
        selection.kind === "chosen"
          ? selection.locale
          : (resolveUiLocale(migrated.locale ?? migrated.prefs.visitorLocale) ??
            "en");
      const messages = await operations.loadBootMessages(locale);
      if (!current()) {
        return operations.getPrefs();
      }
      let prefs = migrated.prefs;
      if (prefs.visitorLocale !== locale) {
        prefs = await operations.writePrefs({ visitorLocale: locale });
      }
      if (!current()) {
        return operations.getPrefs();
      }
      operations.applyBoot({ locale, messages, prefs });
      applied.set(queryClient, userId);
      return prefs;
    });

  const select = async (queryClient: QueryClient, locale: SupportedLanguage) =>
    enqueue(async () => {
      const session = await Result.tryPromise(
        async () => await operations.readSelectionUser(),
      );
      if (session.isErr()) {
        operations.reportSelectionError(session.error, "setLang:getSession");
        return;
      }
      const userId = session.value?.id ?? null;
      const current = () => operations.isCurrent(queryClient, userId);
      if (!current()) {
        return;
      }
      if (userId !== null) {
        const updated = await operations.updateProfile(locale);
        if (updated.isErr()) {
          operations.reportSelectionError(updated.error, "setLang:updateUser");
          return;
        }
      }
      if (!current()) {
        return;
      }
      const loaded = await Result.tryPromise(
        async () => await operations.loadSelectedMessages(locale, current),
      );
      if (loaded.isErr()) {
        applied.delete(queryClient);
        operations.reportSelectionError(loaded.error, "setLang:loadMessages");
        return;
      }
      if (!current() || operations.loadedLocale() !== locale) {
        applied.delete(queryClient);
        return;
      }
      selection = { kind: "chosen", userId, locale };
      const persisted = await Result.tryPromise(
        async () => await operations.writePrefs({ visitorLocale: locale }),
      );
      if (persisted.isErr()) {
        applied.delete(queryClient);
        operations.reportSelectionError(
          persisted.error,
          "setLang:visitorLocale",
        );
        return;
      }
      if (!current()) {
        return;
      }
      applied.set(queryClient, userId);
    });

  return { boot, select };
};

const reportSelectionError = (
  error: unknown,
  fingerprintKey: DocumentLocaleFingerprint,
) => {
  getAnalytics().captureError(error, {
    fingerprintKey,
    scope: { type: "handler", handlerId: fingerprintKey },
  });
  notifyUserError(error, getTranslator()("errors.actionFailed"));
};

const updateProfileLocale = async (locale: SupportedLanguage) => {
  const updated = await Result.tryPromise(async () => {
    const { authClient } = await import("@/lib/auth-client");
    return await authClient.updateUser({ locale });
  });
  if (updated.isErr()) {
    return Result.err(updated.error);
  }
  return updated.value.error
    ? Result.err(toAuthClientError(updated.value.error))
    : Result.ok(undefined);
};

const clientLocaleOwner = createClientDocumentLocaleOwner({
  readBootUser: async (queryClient) => {
    const { user } = await loadAuthContext(queryClient);
    return user === null ? null : { id: user.id, locale: user.locale ?? null };
  },
  readSelectionUser: async () => {
    const session = await fetchSession();
    return session?.user === undefined
      ? null
      : { id: session.user.id, locale: session.user.locale ?? null };
  },
  isCurrent: isCurrentDocumentSession,
  getPrefs: getBrowserPresentationPrefs,
  migrate: async ({ prefs, user, localePriority, isCurrent }) =>
    await migrateLegacyPresentationPreferences({
      prefs,
      profileLocale: resolveUiLocale(user?.locale ?? "") ?? null,
      userId: user?.id ?? null,
      localePriority,
      isCurrentDocument: isCurrent,
      writePrefs: writeBrowserPresentationPrefs,
      writeProfileLocale: updateProfileLocale,
    }),
  writePrefs: writeBrowserPresentationPrefs,
  updateProfile: updateProfileLocale,
  loadBootMessages: loadLocaleMessages,
  applyBoot: applyClientDocumentLocale,
  loadSelectedMessages: async (locale, isCurrent) =>
    await useI18nStore.getState().loadMessages(locale, isCurrent),
  loadedLocale: () => useI18nStore.getState().loadedLang,
  reportSelectionError,
});

export const loadClientDocumentPresentation = clientLocaleOwner.boot;
export const setLang = async (
  queryClient: QueryClient,
  locale: SupportedLanguage,
) => clientLocaleOwner.select(queryClient, locale);
