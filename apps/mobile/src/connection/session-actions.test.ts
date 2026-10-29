import { expect, test } from "bun:test";

import {
  createSessionStore,
  type SessionGeneration,
  type StoredSession,
} from "./session";
import { signOutSession } from "./session-actions";

const SESSION = {
  signInId: "sign-in-a",
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId: "mobile-client",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-a",
} satisfies StoredSession;

for (const waitingOn of ["revocation", "deletion"] as const) {
  test(`sign-in remains current after sign-out finishes ${waitingOn}`, async () => {
    const reached = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    let stored: StoredSession | null | undefined = SESSION;
    let published: StoredSession | undefined = SESSION;
    const store = createSessionStore({
      read: async () => stored,
      write: async (session) => {
        stored = session;
      },
      prepareClear: async () => {
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
      revoke: async () => {
        if (waitingOn === "revocation") {
          reached.resolve(undefined);
          await resume.promise;
        }
      },
      publish: (generation) => {
        updates.push(generation);
      },
    });
    await reached.promise;
    const replacement = {
      ...SESSION,
      signInId: "sign-in-b",
      refreshToken: "refresh-b",
    };
    const signingIn = store.begin();
    const keeping = signingIn.write(replacement);
    if (waitingOn === "revocation") {
      await keeping;
    }
    resume.resolve(undefined);
    expect((await signingOut).isOk()).toBeTrue();
    const kept = await keeping;
    expect(kept.type).toBe("committed");
    store.commit(signingIn.generation, () => {
      published = replacement;
    });
    const pendingUpdate = updates.at(0);
    if (pendingUpdate !== undefined) {
      store.commit(pendingUpdate, () => {
        published = undefined;
      });
    }
    expect(updates).toEqual([]);
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
  const previous = store.begin();
  const current = store.begin();
  let published = "current";
  store.commit(previous.generation, () => {
    published = "previous";
  });
  expect(published).toBe("current");
  store.commit(current.generation, () => {
    published = "replacement";
  });
  expect(published).toBe("replacement");
});
