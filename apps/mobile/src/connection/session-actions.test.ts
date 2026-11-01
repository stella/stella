import { expect, test } from "bun:test";

import {
  createAccessTokenSource,
  createSessionStore,
  type SessionGeneration,
  type StoredSession,
} from "./session";
import { keepSignIn, signOutSession } from "./session-actions";

const SESSION = {
  signInId: "sign-in-a",
  userId: "user-a",
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId: "mobile-client",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-a",
} satisfies StoredSession;

for (const waitingOn of ["cleanup", "revocation", "deletion"] as const) {
  test(`sign-in remains current after sign-out finishes ${waitingOn}`, async () => {
    const reached = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    let stored: StoredSession | null | undefined = SESSION;
    let published: StoredSession | undefined = SESSION;
    const revoked: StoredSession[] = [];
    let clearAttempts = 0;
    const store = createSessionStore({
      read: async () => stored,
      write: async (session) => {
        stored = session;
      },
      prepareClear: async () => {
        clearAttempts++;
        stored = null;
      },
      clear: async () => {
        if (waitingOn === "deletion") {
          reached.resolve(undefined);
          await resume.promise;
        }
        stored = undefined;
      },
    });
    const updates: SessionGeneration[] = [];
    const signingOut = signOutSession({
      store,
      session: SESSION,
      beforeEnd: async () => {
        if (waitingOn === "cleanup") {
          reached.resolve(undefined);
          await resume.promise;
        }
      },
      revoke: async (session) => {
        revoked.push(session);
        if (waitingOn === "revocation") {
          reached.resolve(undefined);
          await resume.promise;
        }
      },
      publish: (generation) => {
        updates.push(generation);
      },
      kept: () => {},
    });
    await reached.promise;
    const replacement = {
      ...SESSION,
      signInId: "sign-in-b",
      refreshToken: "refresh-b",
    };
    const signingIn = store.begin();
    const keeping = signingIn.write(replacement);
    if (waitingOn !== "deletion") {
      await keeping;
    }
    resume.resolve(undefined);
    expect((await signingOut).isOk()).toBeTrue();
    const kept = await keeping;
    if (kept.type !== "committed") {
      throw new Error("expected the replacement sign-in to commit");
    }
    store.commit(kept.generation, () => {
      published = replacement;
    });
    const pendingUpdate = updates.at(0);
    if (pendingUpdate !== undefined) {
      store.commit(pendingUpdate, () => {
        published = undefined;
      });
    }
    expect(updates).toEqual([]);
    expect(revoked).toEqual([SESSION]);
    expect(clearAttempts).toBe(waitingOn === "deletion" ? 1 : 0);
    expect(stored).toEqual(replacement);
    expect(published).toEqual(replacement);
  });
}

test("deferred state updates belong to the generation that scheduled them", () => {
  const store = createSessionStore({
    read: async () => undefined,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  const previous = store.advance();
  const current = store.advance();
  let published = "current";
  store.commit(previous, () => {
    published = "previous";
  });
  expect(published).toBe("current");
  store.commit(current, () => {
    published = "replacement";
  });
  expect(published).toBe("replacement");
});

test("session cleanup can authenticate before its credentials are retired", async () => {
  let stored: StoredSession | null | undefined = SESSION;
  const store = createSessionStore({
    read: async () => stored,
    write: async (session) => {
      stored = session;
    },
    prepareClear: async () => {
      stored = null;
    },
    clear: async () => {
      stored = undefined;
    },
  });
  const source = createAccessTokenSource({
    fetch: async () =>
      Response.json({ error: "unexpected_refresh" }, { status: 400 }),
    initialAccess: { token: "cleanup-access", expiresAt: 900_000 },
    now: () => 0,
    session: SESSION,
    generation: store.generation(),
    store,
  });
  let cleaned = false;
  let kept = 0;
  const outcome = await signOutSession({
    store,
    session: SESSION,
    beforeEnd: async () => {
      expect(source.session()).toEqual(SESSION);
      expect((await source.accessToken()).unwrap()).toBe("cleanup-access");
      cleaned = true;
    },
    revoke: async () => {},
    publish: () => {},
    kept: () => {
      kept++;
    },
  });
  expect(outcome.isOk()).toBeTrue();
  expect(kept).toBe(0);
  expect(cleaned).toBeTrue();
  expect(source.session()).toBeUndefined();
  expect(stored).toBeUndefined();
});

for (const outlived of ["keychain-kept", "sign-in-took-over"] as const) {
  test(`a sign-out the session outlives (${outlived}) lets a later end run`, async () => {
    let stored: StoredSession | null | undefined = SESSION;
    const store = createSessionStore({
      read: async () => stored,
      write: async (session) => {
        stored = session;
      },
      prepareClear: async () => {
        if (outlived === "keychain-kept") {
          throw new Error("keychain locked");
        }
        // A sign-in starts while the keychain is being cleared, then is
        // cancelled before it writes anything.
        store.begin();
        stored = null;
      },
      clear: async () => {
        stored = undefined;
      },
    });
    const generation = store.generation();
    const published: SessionGeneration[] = [];
    let kept = 0;
    const outcome = await signOutSession({
      store,
      session: SESSION,
      beforeEnd: async () => {},
      revoke: async () => {},
      publish: (next) => {
        published.push(next);
      },
      kept: () => {
        kept++;
      },
    });
    expect(outcome.isErr()).toBe(outlived === "keychain-kept");
    expect(published).toEqual([]);
    expect(store.isCurrent(generation)).toBeTrue();
    expect(kept).toBe(1);
  });
}

const SIGN_IN_B = {
  ...SESSION,
  signInId: "sign-in-b",
  refreshToken: "refresh-b",
} satisfies StoredSession;

for (const overtaken of ["before-write", "during-write"] as const) {
  test(`a sign-in overtaken ${overtaken} gives its grant back`, async () => {
    const writing = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    let stored: StoredSession | null | undefined;
    const store = createSessionStore({
      read: async () => stored,
      write: async (session) => {
        if (session === SESSION && overtaken === "during-write") {
          writing.resolve(undefined);
          await resume.promise;
        }
        stored = session;
      },
      prepareClear: async () => {
        stored = null;
      },
      clear: async () => {
        stored = undefined;
      },
    });
    const revoked: StoredSession[] = [];
    const published: SessionGeneration[] = [];
    const keeping = keepSignIn({
      store,
      transition: store.begin(),
      session: SESSION,
      revoke: async (session) => {
        revoked.push(session);
      },
      publish: (generation) => {
        published.push(generation);
      },
    });
    if (overtaken === "during-write") {
      await writing.promise;
    }
    const later = store.begin();
    resume.resolve(undefined);
    expect((await keeping).isOk()).toBeTrue();
    expect((await later.write(SIGN_IN_B)).type).toBe("committed");
    expect(revoked).toEqual([SESSION]);
    expect(published).toEqual([]);
    expect(stored).toEqual(SIGN_IN_B);
  });
}

test("a sign-in the keychain refuses fails and gives its grant back", async () => {
  const store = createSessionStore({
    read: async () => undefined,
    write: async () => {
      throw new Error("keychain locked");
    },
    prepareClear: async () => {},
    clear: async () => {},
  });
  const revoked: StoredSession[] = [];
  const published: SessionGeneration[] = [];
  const outcome = await keepSignIn({
    store,
    transition: store.begin(),
    session: SESSION,
    revoke: async (session) => {
      revoked.push(session);
    },
    publish: (generation) => {
      published.push(generation);
    },
  });
  expect(outcome.isErr()).toBeTrue();
  expect(revoked).toEqual([SESSION]);
  expect(published).toEqual([]);
});

test("a sign-in that commits publishes its generation and keeps its grant", async () => {
  let stored: StoredSession | null | undefined;
  const store = createSessionStore({
    read: async () => stored,
    write: async (session) => {
      stored = session;
    },
    prepareClear: async () => {},
    clear: async () => {},
  });
  const before = store.generation();
  const revoked: StoredSession[] = [];
  const published: SessionGeneration[] = [];
  const outcome = await keepSignIn({
    store,
    transition: store.begin(),
    session: SESSION,
    revoke: async (session) => {
      revoked.push(session);
    },
    publish: (generation) => {
      published.push(generation);
    },
  });
  expect(outcome.isOk()).toBeTrue();
  expect(revoked).toEqual([]);
  expect(published).toEqual([store.generation()]);
  expect(store.isCurrent(before)).toBeFalse();
  expect(stored).toEqual(SESSION);
});
