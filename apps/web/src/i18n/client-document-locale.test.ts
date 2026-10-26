import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import { defaultPresentationPrefs } from "@/lib/account/presentation-prefs/preferences";

import { createClientDocumentLocaleOwner } from "./client-document-locale";
import { loadLocaleMessages } from "./i18n-store";
import type { SupportedLanguage } from "./i18n-store";

const createHarness = ({
  bootGate,
  selectedGate,
  currentUser,
  bootEntered,
  selectedEntered,
  onWritePrefs,
  onLoadSelectedMessages,
}: {
  bootGate?: Promise<unknown>;
  selectedGate?: Promise<unknown>;
  currentUser?: () => string;
  bootEntered?: () => void;
  selectedEntered?: () => void;
  onWritePrefs?: (patch: Partial<typeof defaultPresentationPrefs>) => void;
  onLoadSelectedMessages?: (locale: SupportedLanguage) => void;
} = {}) => {
  let prefs = defaultPresentationPrefs;
  let visible: SupportedLanguage = "en";
  const profileWrites: SupportedLanguage[] = [];
  const reportedErrors: string[] = [];
  const owner = createClientDocumentLocaleOwner({
    readBootUser: async () => ({ id: "member", locale: "de" }),
    readSelectionUser: async () => ({ id: "member", locale: "de" }),
    isCurrent: (_queryClient, userId) =>
      userId === (currentUser?.() ?? "member"),
    getPrefs: () => prefs,
    migrate: async ({ user }) => ({ prefs, locale: user?.locale ?? null }),
    writePrefs: async (patch) => {
      onWritePrefs?.(patch);
      prefs = { ...prefs, ...patch };
      return prefs;
    },
    updateProfile: async (locale) => {
      profileWrites.push(locale);
    },
    loadBootMessages: async (locale) => {
      bootEntered?.();
      await bootGate;
      return await loadLocaleMessages(locale);
    },
    applyBoot: ({ locale }) => {
      visible = locale;
    },
    loadSelectedMessages: async (locale, isCurrent) => {
      onLoadSelectedMessages?.(locale);
      if (locale === "cs") {
        selectedEntered?.();
        await selectedGate;
      }
      if (isCurrent()) {
        visible = locale;
      }
    },
    loadedLocale: () => visible,
    reportSelectionError: (_error, fingerprintKey) => {
      reportedErrors.push(fingerprintKey);
    },
  });
  return {
    owner,
    current: () => ({ prefs, visible, profileWrites, reportedErrors }),
  };
};

test("rapid member selections settle on the last chosen catalogue and cookie", async () => {
  const gate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const queryClient = new QueryClient();
  const { owner, current } = createHarness({
    selectedGate: gate.promise,
    selectedEntered: () => entered.resolve(undefined),
  });
  const first = owner.select(queryClient, "cs");
  await entered.promise;
  const second = owner.select(queryClient, "ar");
  expect(current().profileWrites).toEqual(["cs"]);
  expect(current().prefs.visitorLocale).toBe("en");
  gate.resolve(undefined);
  await Promise.all([first, second]);
  expect(current()).toEqual({
    prefs: { ...defaultPresentationPrefs, visitorLocale: "ar" },
    visible: "ar",
    profileWrites: ["cs", "ar"],
    reportedErrors: [],
  });
  queryClient.clear();
});

test("selection queued behind an old profile application remains authoritative", async () => {
  const gate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const queryClient = new QueryClient();
  const { owner, current } = createHarness({
    bootGate: gate.promise,
    bootEntered: () => entered.resolve(undefined),
  });
  const boot = owner.boot(queryClient);
  await entered.promise;
  const selection = owner.select(queryClient, "cs");
  expect(current().profileWrites).toEqual([]);
  gate.resolve(undefined);
  await Promise.all([boot, selection]);
  expect(current().visible).toBe("cs");
  expect(current().prefs.visitorLocale).toBe("cs");
  await owner.boot(queryClient);
  expect(current().visible).toBe("cs");
  expect(current().prefs.visitorLocale).toBe("cs");
  queryClient.clear();
});

test("a boot queued after a selection cannot replay the cached old profile", async () => {
  const gate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const queryClient = new QueryClient();
  const { owner, current } = createHarness({
    selectedGate: gate.promise,
    selectedEntered: () => entered.resolve(undefined),
  });
  const selection = owner.select(queryClient, "cs");
  await entered.promise;
  const boot = owner.boot(queryClient);
  gate.resolve(undefined);
  await Promise.all([selection, boot]);
  expect(current().visible).toBe("cs");
  expect(current().prefs.visitorLocale).toBe("cs");
  queryClient.clear();
});

test("an identity transition during catalogue loading blocks the old user's cookie and live locale", async () => {
  const gate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const queryClient = new QueryClient();
  let currentUser = "member";
  const { owner, current } = createHarness({
    selectedGate: gate.promise,
    selectedEntered: () => entered.resolve(undefined),
    currentUser: () => currentUser,
  });
  const selection = owner.select(queryClient, "cs");
  await entered.promise;
  currentUser = "other-member";
  gate.resolve(undefined);
  await selection;
  expect(current().prefs.visitorLocale).toBe("en");
  expect(current().visible).toBe("en");
  queryClient.clear();
});

test("a profile load abandoned by an identity transition cannot apply to the next member", async () => {
  const gate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const queryClient = new QueryClient();
  let currentUser = "member";
  const { owner, current } = createHarness({
    bootGate: gate.promise,
    bootEntered: () => entered.resolve(undefined),
    currentUser: () => currentUser,
  });
  const boot = owner.boot(queryClient);
  await entered.promise;
  currentUser = "other-member";
  gate.resolve(undefined);
  await boot;
  expect(current().prefs.visitorLocale).toBe("en");
  expect(current().visible).toBe("en");
  queryClient.clear();
});

test("a failed catalogue load leaves the queue usable for a later selection", async () => {
  const queryClient = new QueryClient();
  let failCs = true;
  const { owner, current } = createHarness({
    onLoadSelectedMessages: (locale) => {
      if (locale === "cs" && failCs) {
        failCs = false;
        throw new Error("catalogue unavailable");
      }
    },
  });
  try {
    await owner.select(queryClient, "cs");
    expect(current().visible).toBe("en");
    expect(current().prefs.visitorLocale).toBe("en");
    expect(current().reportedErrors).toEqual(["setLang:loadMessages"]);

    await owner.select(queryClient, "ar");
    expect(current().visible).toBe("ar");
    expect(current().prefs.visitorLocale).toBe("ar");
    expect(current().reportedErrors).toEqual(["setLang:loadMessages"]);
  } finally {
    queryClient.clear();
  }
});

test("a failed preference write leaves the queue usable for a later boot", async () => {
  const queryClient = new QueryClient();
  let failCs = true;
  const { owner, current } = createHarness({
    onWritePrefs: ({ visitorLocale }) => {
      if (visitorLocale === "cs" && failCs) {
        failCs = false;
        throw new Error("cookie unavailable");
      }
    },
  });
  try {
    await owner.select(queryClient, "cs");
    expect(current().visible).toBe("cs");
    expect(current().prefs.visitorLocale).toBe("en");
    expect(current().reportedErrors).toEqual(["setLang:visitorLocale"]);

    await owner.boot(queryClient);
    expect(current().visible).toBe("cs");
    expect(current().prefs.visitorLocale).toBe("cs");
    expect(current().profileWrites).toEqual(["cs"]);
    expect(current().reportedErrors).toEqual(["setLang:visitorLocale"]);
  } finally {
    queryClient.clear();
  }
});
