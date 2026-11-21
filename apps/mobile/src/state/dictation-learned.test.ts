import { describe, expect, test } from "bun:test";

import type { StoredSession } from "@/connection/session";
import { createSessionEndBoundary } from "@/connection/session-end";

import {
  deleteLearnedFixes,
  forgetLearnedFixes,
  readLearnedFixes,
  updateLearnedFixes,
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
    await updateLearnedFixes(store, SESSION, () => [FIX]);
    expect(await readLearnedFixes(store, SESSION)).toEqual([FIX]);
    expect(
      await readLearnedFixes(store, { ...SESSION, userId: "user-2" }),
    ).toEqual([]);
  });

  test("changes made at once each read what the one before wrote", async () => {
    const { store } = memoryStore();
    const seen = (fixes: readonly { seen: number }[]) => fixes.at(0)?.seen ?? 0;
    const bump = async () =>
      await updateLearnedFixes(store, SESSION, (fixes) => [
        { ...FIX, seen: seen(fixes) + 1 },
      ]);
    await Promise.all([bump(), bump()]);
    expect(seen(await readLearnedFixes(store, SESSION))).toBe(2);
  });

  test("a change still under way at sign-out writes nothing after it", async () => {
    const { items, store } = memoryStore();
    const session = { ...SESSION, signInId: "sign-in-ending" };
    const boundary = createSessionEndBoundary();
    boundary.register(forgetLearnedFixes(store));
    const pending = updateLearnedFixes(store, session, () => [FIX]);
    const ended = boundary.run("signed-out", session);
    await Promise.all([pending, ended]);
    await updateLearnedFixes(store, session, () => [FIX]);
    expect(items.size).toBe(0);
  });

  test("nothing learned leaves nothing stored", async () => {
    const { items, store } = memoryStore();
    await updateLearnedFixes(store, SESSION, () => [FIX]);
    await deleteLearnedFixes(store, SESSION);
    expect(items.size).toBe(0);
  });

  test("a value this build cannot read counts as nothing learned", async () => {
    const { items, store } = memoryStore();
    await updateLearnedFixes(store, SESSION, () => [FIX]);
    const [key] = items.keys();
    items.set(key ?? "", '[{"from":"stela","to":"stella","seen":0}]');
    expect(await readLearnedFixes(store, SESSION)).toEqual([]);
  });

  test("sign-out forgets them", async () => {
    const { items, store } = memoryStore();
    await updateLearnedFixes(store, SESSION, () => [FIX]);
    const boundary = createSessionEndBoundary();
    boundary.register(forgetLearnedFixes(store));
    await boundary.run("signed-out", SESSION);
    expect(items.size).toBe(0);
  });
});
