import { Result } from "better-result";
import { expect, test } from "bun:test";

import { type InstallMarker, withInstallMarker } from "./install-marker";
import { createSessionStore, type StoredSession } from "./session";
import { keepSignIn, restoreSession, signOutSession } from "./session-actions";

const SESSION = {
  signInId: "sign-in-a",
  userId: "user-a",
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId: "mobile-client",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  revocationEndpoint: "https://stella.example.com/api/auth/oauth2/revoke",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-a",
} satisfies StoredSession;

type MarkerFailure = "read" | "write" | "remove";

/**
 * A device as the app finds it at launch: what the keychain kept, which
 * survives the app's removal, and the marker file, which does not.
 */
const device = ({
  kept,
  marked,
  fails,
}: {
  readonly kept: StoredSession | undefined;
  readonly marked: string | undefined;
  readonly fails?: MarkerFailure | undefined;
}) => {
  const state: {
    keychain: StoredSession | null | undefined;
    marker: string | undefined;
  } = { keychain: kept, marker: marked };
  const failure = (operation: MarkerFailure) =>
    fails === operation
      ? new Error(`The marker file could not be used: ${operation}`)
      : undefined;
  const marker: InstallMarker = {
    read: async () => {
      const failed = failure("read");
      if (failed !== undefined) {
        throw failed;
      }
      return state.marker === undefined
        ? { type: "missing" }
        : { type: "present", signInId: state.marker };
    },
    write: async (signInId) => {
      const failed = failure("write");
      if (failed !== undefined) {
        throw failed;
      }
      state.marker = signInId;
    },
    remove: () => {
      const failed = failure("remove");
      if (failed !== undefined) {
        throw failed;
      }
      state.marker = undefined;
    },
  };
  const store = createSessionStore(
    withInstallMarker(
      {
        read: async () => state.keychain,
        write: async (session) => {
          state.keychain = session;
        },
        prepareClear: async () => {
          state.keychain = null;
        },
        clear: async () => {
          state.keychain = undefined;
        },
      },
      marker,
    ),
  );
  const revoked: StoredSession[] = [];
  const ended: StoredSession[] = [];
  const restore = async () =>
    await restoreSession({
      store,
      generation: store.generation(),
      marker,
      beforeEnd: async (session) => {
        ended.push(session);
      },
      revoke: async (session) => {
        revoked.push(session);
      },
    });
  return { state, marker, store, revoked, ended, restore };
};

test("a session this installation signed in is restored as kept", async () => {
  const phone = device({ kept: SESSION, marked: SESSION.signInId });

  expect(await phone.restore()).toEqual(SESSION);
  expect(phone.state).toEqual({ keychain: SESSION, marker: SESSION.signInId });
  expect(phone.revoked).toEqual([]);
  expect(phone.ended).toEqual([]);
});

for (const [situation, marked] of [
  ["without a marker", undefined],
  ["with a marker naming another sign-in", "sign-in-b"],
] as const) {
  test(`a kept session ${situation} is signed out as a reinstall`, async () => {
    const phone = device({ kept: SESSION, marked });
    expect(phone.state.marker).not.toBe(SESSION.signInId);

    expect(await phone.restore()).toBeUndefined();
    expect(phone.state).toEqual({ keychain: undefined, marker: undefined });
    expect(phone.ended).toEqual([SESSION]);
    expect(phone.revoked).toEqual([SESSION]);
  });
}

test("a marker that cannot be read keeps the session", async () => {
  const phone = device({ kept: SESSION, marked: undefined, fails: "read" });

  expect(await phone.restore()).toEqual(SESSION);
  expect(phone.state.keychain).toEqual(SESSION);
  expect(phone.revoked).toEqual([]);
  expect(phone.ended).toEqual([]);
});

test("a launch with nothing kept leaves a stray marker alone", async () => {
  const phone = device({ kept: undefined, marked: "sign-in-b" });

  expect(await phone.restore()).toBeUndefined();
  expect(phone.state.marker).toBe("sign-in-b");
  expect(phone.revoked).toEqual([]);
});

test("a sign-in names itself in the marker, so the next launch keeps it", async () => {
  const phone = device({ kept: undefined, marked: undefined });
  const published: unknown[] = [];

  const kept = await keepSignIn({
    store: phone.store,
    transition: phone.store.begin(),
    session: SESSION,
    revoke: async (session) => {
      phone.revoked.push(session);
    },
    publish: (generation) => {
      published.push(generation);
    },
  });

  expect(Result.isOk(kept)).toBe(true);
  expect(published).toHaveLength(1);
  expect(phone.state).toEqual({ keychain: SESSION, marker: SESSION.signInId });
  expect(await phone.restore()).toEqual(SESSION);
});

test("a sign-in whose marker cannot be written is not kept", async () => {
  const phone = device({ kept: undefined, marked: undefined, fails: "write" });
  const published: unknown[] = [];

  const kept = await keepSignIn({
    store: phone.store,
    transition: phone.store.begin(),
    session: SESSION,
    revoke: async (session) => {
      phone.revoked.push(session);
    },
    publish: (generation) => {
      published.push(generation);
    },
  });

  expect(Result.isError(kept)).toBe(true);
  expect(published).toEqual([]);
  expect(phone.state).toEqual({ keychain: undefined, marker: undefined });
  expect(phone.revoked).toEqual([SESSION]);
});

test("a rotated refresh token stays named by the same marker", async () => {
  const phone = device({ kept: SESSION, marked: SESSION.signInId });
  const rotated = { ...SESSION, refreshToken: "refresh-a2" };

  const written = await phone.store.write(rotated, phone.store.generation());

  expect(written.type).toBe("committed");
  expect(phone.state).toEqual({ keychain: rotated, marker: SESSION.signInId });
});

for (const fails of [undefined, "remove"] as const) {
  test(`sign-out deletes the marker with the session${fails === undefined ? "" : ", and stands when the marker stays"}`, async () => {
    const phone = device({ kept: SESSION, marked: SESSION.signInId, fails });
    const published: unknown[] = [];

    const signedOut = await signOutSession({
      store: phone.store,
      session: SESSION,
      beforeEnd: async () => {},
      revoke: async (session) => {
        phone.revoked.push(session);
      },
      publish: (generation) => {
        published.push(generation);
      },
      kept: () => {},
    });

    expect(Result.isOk(signedOut)).toBe(true);
    expect(published).toHaveLength(1);
    expect(phone.state).toEqual({
      keychain: undefined,
      marker: fails === "remove" ? SESSION.signInId : undefined,
    });
    expect(phone.revoked).toEqual([SESSION]);
  });
}
