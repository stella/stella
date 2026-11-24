import { describe, expect, test } from "bun:test";

import type { StoredSession } from "@/connection/session";
import { createSessionEndBoundary } from "@/connection/session-end";

import {
  chosenModelId,
  DEFAULT_DICTATION_PREFERENCES,
  forgetDictationPreferences,
  readDictationChoice,
  readDictationPreferences,
  shownModel,
  writeDictationPreferences,
} from "./dictation-preferences";
import type { AccountStore } from "./recent-searches";

const memoryStore = () => {
  const items = new Map<string, string>();
  const store: AccountStore = {
    read: async (key) => items.get(key) ?? null,
    write: async (key, value) => {
      items.set(key, value);
    },
    remove: async (key) => {
      items.delete(key);
    },
  };
  return { items, store };
};

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  signInId: "sign-in-1",
  refreshToken: "refresh-1",
  userId: "user-1",
};
const ACCOUNT = { serverUrl: SESSION.serverUrl, userId: SESSION.userId };

describe("dictation preferences", () => {
  test("nothing kept reads as the defaults", async () => {
    const { store } = memoryStore();
    expect(await readDictationPreferences(store, ACCOUNT)).toEqual(
      DEFAULT_DICTATION_PREFERENCES,
    );
  });

  test("a choice reads back for its account only", async () => {
    const { store } = memoryStore();
    const picked = {
      modelId: "elevenlabs/scribe-v3",
      modelClass: null,
      cleanup: true,
      style: "notes",
      translateTo: "en",
      microphone: "system",
    } as const;
    await writeDictationPreferences(store, ACCOUNT, picked);

    expect(await readDictationPreferences(store, ACCOUNT)).toEqual(picked);
    expect(
      await readDictationPreferences(store, { ...ACCOUNT, userId: "user-2" }),
    ).toEqual(DEFAULT_DICTATION_PREFERENCES);
  });

  test("a choice kept before styles reads with the default style and no translation", async () => {
    const { items, store } = memoryStore();
    await writeDictationPreferences(
      store,
      ACCOUNT,
      DEFAULT_DICTATION_PREFERENCES,
    );
    for (const key of items.keys()) {
      items.set(key, JSON.stringify({ modelId: "m", cleanup: true }));
    }
    expect(await readDictationPreferences(store, ACCOUNT)).toEqual({
      ...DEFAULT_DICTATION_PREFERENCES,
      modelId: "m",
      cleanup: true,
    });
    for (const key of items.keys()) {
      items.set(
        key,
        JSON.stringify({
          modelId: null,
          cleanup: true,
          style: "formal",
          translateTo: "xx",
        }),
      );
    }
    expect(await readDictationPreferences(store, ACCOUNT)).toEqual({
      ...DEFAULT_DICTATION_PREFERENCES,
      cleanup: true,
    });
  });

  test("choices kept before the microphone was one record from the iPhone's", async () => {
    const { items, store } = memoryStore();
    await writeDictationPreferences(
      store,
      ACCOUNT,
      DEFAULT_DICTATION_PREFERENCES,
    );
    for (const key of items.keys()) {
      items.set(key, JSON.stringify({ modelId: "m", cleanup: true }));
    }
    expect(await readDictationPreferences(store, ACCOUNT)).toEqual({
      ...DEFAULT_DICTATION_PREFERENCES,
      modelId: "m",
      cleanup: true,
      microphone: "built-in",
    });
  });

  test("a value this build cannot read is the defaults", async () => {
    const { items, store } = memoryStore();
    await writeDictationPreferences(store, ACCOUNT, {
      ...DEFAULT_DICTATION_PREFERENCES,
      modelId: null,
      modelClass: null,
      cleanup: true,
      microphone: "built-in",
    });
    for (const key of items.keys()) {
      items.set(key, "{not json");
    }
    expect(await readDictationPreferences(store, ACCOUNT)).toEqual(
      DEFAULT_DICTATION_PREFERENCES,
    );
  });

  test("sign-out forgets them", async () => {
    const { items, store } = memoryStore();
    await writeDictationPreferences(store, ACCOUNT, {
      ...DEFAULT_DICTATION_PREFERENCES,
      modelId: "m",
      modelClass: null,
      cleanup: true,
      microphone: "system",
    });
    const boundary = createSessionEndBoundary();
    boundary.register(forgetDictationPreferences(store));
    await boundary.run("signed-out", SESSION);
    expect(items.size).toBe(0);
  });

  test("a picked model stays named, offered or not", () => {
    const picked = { ...DEFAULT_DICTATION_PREFERENCES, modelId: "m" };
    expect(chosenModelId(picked)).toBe("m");
    expect(chosenModelId(DEFAULT_DICTATION_PREFERENCES)).toBeUndefined();
  });

  test("settings show the picked model and where it stands in the list", () => {
    const picked = { ...DEFAULT_DICTATION_PREFERENCES, modelId: "m" };
    expect(shownModel(picked, [{ id: "m" }])).toEqual({
      selected: "m",
      standing: "listed",
    });
    expect(shownModel(picked, [{ id: "other" }])).toEqual({
      selected: "m",
      standing: "withdrawn",
    });
    expect(shownModel(picked, null)).toEqual({
      selected: "m",
      standing: "unread",
    });
    expect(shownModel(DEFAULT_DICTATION_PREFERENCES, null)).toEqual({
      selected: null,
      standing: "listed",
    });
  });

  test("the picked model's class reads back; one kept before it reads as unknown", async () => {
    const { items, store } = memoryStore();
    const modelClass = {
      provider: "Provider A",
      outsideRegion: false,
      retainsData: false,
    };
    await writeDictationPreferences(store, ACCOUNT, {
      ...DEFAULT_DICTATION_PREFERENCES,
      modelId: "m",
      modelClass,
    });
    expect((await readDictationPreferences(store, ACCOUNT)).modelClass).toEqual(
      modelClass,
    );
    for (const key of items.keys()) {
      items.set(key, JSON.stringify({ modelId: "m", cleanup: false }));
    }
    expect(
      (await readDictationPreferences(store, ACCOUNT)).modelClass,
    ).toBeNull();
  });
});

describe("the choices a dictation uploads on", () => {
  test("nothing kept is the person's choice of the defaults", async () => {
    const { store } = memoryStore();
    const choice = await readDictationChoice(store, ACCOUNT);
    expect(choice.isOk() && choice.value).toEqual(
      DEFAULT_DICTATION_PREFERENCES,
    );
  });

  test("a kept choice reads back", async () => {
    const { store } = memoryStore();
    const picked = {
      ...DEFAULT_DICTATION_PREFERENCES,
      modelId: "elevenlabs/scribe-v3",
    };
    await writeDictationPreferences(store, ACCOUNT, picked);
    const choice = await readDictationChoice(store, ACCOUNT);
    expect(choice.isOk() && choice.value).toEqual(picked);
  });

  test("a kept choice this build cannot read is an error, never the defaults", async () => {
    const { items, store } = memoryStore();
    await writeDictationPreferences(store, ACCOUNT, {
      ...DEFAULT_DICTATION_PREFERENCES,
      modelId: "elevenlabs/scribe-v3",
    });
    for (const key of items.keys()) {
      items.set(key, "{not json");
    }
    const choice = await readDictationChoice(store, ACCOUNT);
    expect(choice.isErr() && choice.error._tag).toBe(
      "DictationPreferencesUnreadableError",
    );
  });

  test("a store that fails to read is an error, never the defaults", async () => {
    const store: AccountStore = {
      read: async () => await Promise.reject(new Error("keychain locked")),
      write: async () => undefined,
      remove: async () => undefined,
    };
    const choice = await readDictationChoice(store, ACCOUNT);
    expect(choice.isErr() && choice.error._tag).toBe(
      "DictationPreferencesUnreadableError",
    );
  });

  test("no signed-in account is an error", async () => {
    const { store } = memoryStore();
    const choice = await readDictationChoice(store, undefined);
    expect(choice.isErr()).toBe(true);
  });
});
