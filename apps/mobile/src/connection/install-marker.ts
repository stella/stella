// A small file in the app's own documents folder naming the sign-in this
// installation made. iOS deletes that folder with the app but keeps its
// keychain items, so a kept session the marker does not name was kept by an
// earlier installation: a reinstalled app starts signed out.

import { Result } from "better-result";

import type { SessionPersistence, StoredSession } from "./session";

export type InstallMarkerRead =
  | { readonly type: "present"; readonly signInId: string }
  | { readonly type: "missing" };

export type InstallMarker = {
  /** `missing` only when there is no marker; a marker that cannot be read rejects. */
  readonly read: () => Promise<InstallMarkerRead>;
  /** Holds the sign-in's local id only, never a credential. */
  readonly write: (signInId: string) => Promise<void>;
  readonly remove: () => Promise<void>;
};

/**
 * Whether this installation made the kept sign-in. A marker that cannot be
 * read keeps the session: a read failure never signs anyone out.
 */
export const madeByThisInstall = async (
  marker: InstallMarker,
  session: StoredSession,
): Promise<boolean> => {
  const read = await Result.tryPromise(async () => await marker.read());
  if (Result.isError(read)) {
    return true;
  }
  return (
    read.value.type === "present" && read.value.signInId === session.signInId
  );
};

/**
 * Keeps the marker in step with the keychain, inside the session store's
 * queue: every stored session is named by the marker before the keychain
 * holds it, and the marker goes when the keychain lets the session go.
 */
export const withInstallMarker = (
  persistence: SessionPersistence,
  marker: InstallMarker,
): SessionPersistence => ({
  read: async () => await persistence.read(),
  write: async (session) => {
    // A marker that cannot be written fails the write, so no session is
    // kept that the next launch would take for an earlier installation's.
    await marker.write(session.signInId);
    await persistence.write(session);
  },
  prepareClear: async () => {
    await persistence.prepareClear();
  },
  clear: async () => {
    await persistence.clear();
    // The keychain no longer holds the session, so the sign-out stands
    // whether or not the marker goes: a marker left behind names a sign-in
    // nothing holds, and every sign-in has a new random id.
    (await Result.tryPromise(async () => await marker.remove())).unwrapOr(
      undefined,
    );
  },
});
