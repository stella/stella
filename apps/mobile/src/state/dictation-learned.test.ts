import { describe, expect, test } from "bun:test";

import { applyLearnedFixChanges } from "@stll/transcript/learned-fixes";
import type { LearnedFix } from "@stll/transcript/learned-fixes";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
} from "@/connection/session";
import type { StoredSession } from "@/connection/session";
import { createSessionEndBoundary } from "@/connection/session-end";

import {
  deleteLearnedFixes,
  forgetLearnedFixes,
  readLearnedFixes,
  syncLearnedFixes,
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

const FIX = { from: "stela", to: "stella", seen: 1, status: "on" } as const;
const TAUGHT = { type: "taught", from: "stela", to: "stella" } as const;

// A sign-in that signed out stays signed out for this module, also when the
// suite runs again: each test signs in afresh.
let signIns = 0;
const signIn = (): StoredSession => {
  signIns += 1;
  return { ...SESSION, signInId: `sign-in-${String(signIns)}` };
};

const ids = () => {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
};

const sourceFor = (fetch: Fetch, session: StoredSession) => {
  const sessions = createSessionStore({
    read: async () => session,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  return createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session,
    generation: sessions.generation(),
    store: sessions,
  });
};

type Sent = { readonly method: string; readonly body: unknown };

/** The account's copy on the server, changed as the API changes it. */
const fakeServer = (start: { generation: number; fixes: LearnedFix[] }) => {
  const held = { ...start, seenIds: new Set<string>() };
  const sent: Sent[] = [];
  let status = 200;
  const fetch: Fetch = async (url, init) => {
    expect(url).toBe("https://stella.example.com/v1/dictation/learned-fixes");
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ method, body });
    if (status !== 200) {
      return Response.json({ message: "no" }, { status });
    }
    if (method === "DELETE") {
      held.generation += 1;
      held.fixes = [];
    }
    if (
      method === "POST" &&
      typeof body === "object" &&
      body !== null &&
      "generation" in body &&
      "changes" in body &&
      Array.isArray(body.changes) &&
      body.generation === held.generation
    ) {
      const fresh = body.changes.filter(
        (change: { id: string }) => !held.seenIds.has(change.id),
      );
      for (const { id } of fresh) {
        held.seenIds.add(id);
      }
      held.fixes = applyLearnedFixChanges(held.fixes, fresh);
    }
    return Response.json({ generation: held.generation, fixes: held.fixes });
  };
  return {
    fetch,
    held,
    sent,
    refuse: (next: number) => {
      status = next;
    },
  };
};

describe("learned dictation fixes on the phone", () => {
  test("what is learned is read back, per account", async () => {
    const { store } = memoryStore();
    const session = signIn();
    await updateLearnedFixes(store, session, ids(), () => [TAUGHT]);
    expect(await readLearnedFixes(store, session)).toEqual([FIX]);
    expect(
      await readLearnedFixes(store, { ...session, userId: "user-2" }),
    ).toEqual([]);
  });

  test("changes made at once each read what the one before wrote", async () => {
    const { store } = memoryStore();
    const session = signIn();
    const newId = ids();
    const correct = async () =>
      await updateLearnedFixes(store, session, newId, () => [
        { type: "corrected", from: "stela", to: "stella" },
      ]);
    await Promise.all([correct(), correct()]);
    expect(await readLearnedFixes(store, session)).toEqual([
      { from: "stela", to: "stella", seen: 2, status: "on" },
    ]);
  });

  test("a change still under way at sign-out writes nothing after it", async () => {
    const { items, store } = memoryStore();
    const session = signIn();
    const boundary = createSessionEndBoundary();
    boundary.register(forgetLearnedFixes(store));
    const pending = updateLearnedFixes(store, session, ids(), () => [TAUGHT]);
    const ended = boundary.run("signed-out", session);
    await Promise.all([pending, ended]);
    await updateLearnedFixes(store, session, ids(), () => [TAUGHT]);
    expect(items.size).toBe(0);
  });

  test("a change the server would refuse is not kept to send", async () => {
    const { store } = memoryStore();
    const session = signIn();
    const server = fakeServer({ generation: 0, fixes: [] });
    await updateLearnedFixes(store, session, ids(), () => [
      { type: "taught", from: "one two three four", to: "five" },
    ]);
    await syncLearnedFixes({
      store,
      fetch: server.fetch,
      source: sourceFor(server.fetch, session),
      newId: ids(),
    });
    expect(server.sent.map(({ method }) => method)).toEqual(["GET"]);
  });

  test("a value this build cannot read counts as nothing learned", async () => {
    const { items, store } = memoryStore();
    const session = signIn();
    await updateLearnedFixes(store, session, ids(), () => [TAUGHT]);
    const [key] = items.keys();
    items.set(key ?? "", '[{"from":"stela","to":"stella","seen":0}]');
    expect(await readLearnedFixes(store, session)).toEqual([]);
  });

  test("sign-out forgets them", async () => {
    const { items, store } = memoryStore();
    const session = signIn();
    await updateLearnedFixes(store, session, ids(), () => [TAUGHT]);
    const boundary = createSessionEndBoundary();
    boundary.register(forgetLearnedFixes(store));
    await boundary.run("signed-out", session);
    expect(items.size).toBe(0);
  });
});

describe("syncing learned fixes with the person's other devices", () => {
  test("what the phone learned is sent once, and the server's answer kept", async () => {
    const { store } = memoryStore();
    const session = signIn();
    const other = {
      from: "Novakovi",
      to: "Novákovi",
      seen: 2,
      status: "on",
    } as const;
    const server = fakeServer({ generation: 0, fixes: [other] });
    await updateLearnedFixes(store, session, ids(), () => [TAUGHT]);
    const options = {
      store,
      fetch: server.fetch,
      source: sourceFor(server.fetch, session),
      newId: ids(),
    } as const;
    expect(await syncLearnedFixes(options)).toEqual([other, FIX]);
    expect(await syncLearnedFixes(options)).toEqual([other, FIX]);
    expect(server.sent.map(({ method }) => method)).toEqual(["POST", "GET"]);
    expect(await readLearnedFixes(store, session)).toEqual([other, FIX]);
  });

  test("deleting here deletes on the server before anything learned since is sent", async () => {
    const { store } = memoryStore();
    const session = signIn();
    const server = fakeServer({ generation: 0, fixes: [FIX] });
    await deleteLearnedFixes(store, session);
    expect(await readLearnedFixes(store, session)).toEqual([]);
    await updateLearnedFixes(store, session, ids(), () => [
      { type: "taught", from: "Novakovi", to: "Novákovi" },
    ]);
    await syncLearnedFixes({
      store,
      fetch: server.fetch,
      source: sourceFor(server.fetch, session),
      newId: ids(),
    });
    expect(server.sent.map(({ method }) => method)).toEqual(["DELETE", "POST"]);
    expect(server.held).toMatchObject({
      generation: 1,
      fixes: [{ from: "Novakovi", to: "Novákovi", seen: 1, status: "on" }],
    });
  });

  test("what was learned here before another device deleted everything goes with it", async () => {
    const { store } = memoryStore();
    const session = signIn();
    const server = fakeServer({ generation: 3, fixes: [] });
    await updateLearnedFixes(store, session, ids(), () => [TAUGHT]);
    expect(
      await syncLearnedFixes({
        store,
        fetch: server.fetch,
        source: sourceFor(server.fetch, session),
        newId: ids(),
      }),
    ).toEqual([]);
    expect(server.held.fixes).toEqual([]);
  });

  test("a server without the sync leaves the phone learning on its own, and sends later", async () => {
    const { store } = memoryStore();
    const session = signIn();
    const server = fakeServer({ generation: 0, fixes: [] });
    const options = {
      store,
      fetch: server.fetch,
      source: sourceFor(server.fetch, session),
      newId: ids(),
    } as const;
    await updateLearnedFixes(store, session, ids(), () => [TAUGHT]);
    server.refuse(404);
    expect(await syncLearnedFixes(options)).toBeUndefined();
    expect(await readLearnedFixes(store, session)).toEqual([FIX]);
    server.refuse(200);
    expect(await syncLearnedFixes(options)).toEqual([FIX]);
    expect(server.held.fixes).toEqual([FIX]);
  });

  test("fixes an earlier build kept on the phone alone are sent once", async () => {
    const { items, store } = memoryStore();
    const session = signIn();
    const off = {
      from: "Novakovi",
      to: "Novákovi",
      seen: 2,
      status: "off",
    } as const;
    await updateLearnedFixes(store, session, ids(), () => [TAUGHT]);
    const [key] = items.keys();
    items.set(key ?? "", JSON.stringify([FIX, off]));
    const server = fakeServer({ generation: 0, fixes: [] });
    const options = {
      store,
      fetch: server.fetch,
      source: sourceFor(server.fetch, session),
      newId: ids(),
    } as const;
    expect(await readLearnedFixes(store, session)).toEqual([FIX, off]);
    await syncLearnedFixes(options);
    await syncLearnedFixes(options);
    expect(server.held.fixes).toEqual([
      FIX,
      { from: "Novakovi", to: "Novákovi", seen: 1, status: "off" },
    ]);
  });
});
