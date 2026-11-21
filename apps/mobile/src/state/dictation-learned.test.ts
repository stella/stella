import { describe, expect, test } from "bun:test";

import type { StoredSession } from "@/connection/session";
import { createSessionEndBoundary } from "@/connection/session-end";

import {
  forgetLearnedFixes,
  readLearnedFixes,
  writeLearnedFixes,
} from "./dictation-learned";
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

const FIX = { from: "stela", to: "stella", seen: 2, status: "on" } as const;

describe("learned dictation fixes on the phone", () => {
  test("what is written is read back, per account", async () => {
    const { store } = memoryStore();
    await writeLearnedFixes(store, SESSION, [FIX]);
    expect(await readLearnedFixes(store, SESSION)).toEqual([FIX]);
    expect(
      await readLearnedFixes(store, { ...SESSION, userId: "user-2" }),
    ).toEqual([]);
  });

  test("nothing learned leaves nothing stored", async () => {
    const { items, store } = memoryStore();
    await writeLearnedFixes(store, SESSION, [FIX]);
    await writeLearnedFixes(store, SESSION, []);
    expect(items.size).toBe(0);
  });

  test("a value this build cannot read counts as nothing learned", async () => {
    const { items, store } = memoryStore();
    await writeLearnedFixes(store, SESSION, [FIX]);
    const [key] = items.keys();
    items.set(key ?? "", '[{"from":"stela","to":"stella","seen":0}]');
    expect(await readLearnedFixes(store, SESSION)).toEqual([]);
  });

  test("sign-out forgets them", async () => {
    const { items, store } = memoryStore();
    await writeLearnedFixes(store, SESSION, [FIX]);
    const boundary = createSessionEndBoundary();
    boundary.register(forgetLearnedFixes(store));
    await boundary.run("signed-out", SESSION);
    expect(items.size).toBe(0);
  });
});
