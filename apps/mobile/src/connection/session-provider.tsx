import { createContext, use, useState } from "react";

import { panic, Result } from "better-result";

import { apiOAuthResourceUrl } from "@stll/api-contract/api-oauth-resource";

import { epochMilliseconds } from "@/connection/clock";
import {
  deviceCrypto,
  deviceSessionStore,
  openDeviceAuthSession,
} from "@/connection/platform";
import { createAccessTokenSource } from "@/connection/session";
import type {
  AccessToken,
  AccessTokenSource,
  StoredSession,
} from "@/connection/session";
import { signIn as signInToServer } from "@/connection/sign-in";
import type { SignInError } from "@/connection/sign-in";
import { revokeRefreshToken } from "@/connection/tokens";

export type SessionState =
  | {
      readonly status: "signed-out";
      /** The server ended the previous session, so the sign-in screen says so. */
      readonly ended: boolean;
    }
  | { readonly status: "signed-in"; readonly source: AccessTokenSource };

type SessionContextValue = {
  readonly state: SessionState;
  readonly signIn: (
    serverUrlInput: string,
  ) => Promise<Result<void, SignInError>>;
  readonly signOut: () => Promise<void>;
  /** The server refused the session; the person has to sign in again. */
  readonly end: () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * The session a previous run kept, read once as the app starts. A keychain
 * that cannot be read (the device locked during a background launch) starts
 * signed out; signing in writes a fresh session over whatever was there.
 */
const restoredSession: Promise<StoredSession | undefined> = Result.tryPromise(
  async () => await deviceSessionStore.read(),
).then((read) => (Result.isOk(read) ? read.value : undefined));

const sourceFor = (
  session: StoredSession,
  initialAccess: AccessToken | undefined,
): AccessTokenSource =>
  createAccessTokenSource({
    fetch,
    initialAccess,
    now: epochMilliseconds,
    session,
    store: deviceSessionStore,
  });

export const SessionProvider = ({ children }: React.PropsWithChildren) => {
  const restored = use(restoredSession);
  const [state, setState] = useState<SessionState>(() =>
    restored === undefined
      ? { status: "signed-out", ended: false }
      : { status: "signed-in", source: sourceFor(restored, undefined) },
  );

  const value: SessionContextValue = {
    state,
    signIn: async (serverUrlInput) => {
      const signedIn = await signInToServer({
        crypto: deviceCrypto,
        fetch,
        now: epochMilliseconds,
        openAuthSession: openDeviceAuthSession,
        resourceFor: apiOAuthResourceUrl,
        serverUrlInput,
        // Plain http to a simulator host is for development builds only.
        transport: { allowPlainHttp: __DEV__ },
      });
      if (Result.isError(signedIn)) {
        return Result.err(signedIn.error);
      }
      await deviceSessionStore.write(signedIn.value.session);
      setState({
        status: "signed-in",
        source: sourceFor(signedIn.value.session, signedIn.value.access),
      });
      return Result.ok(undefined);
    },
    signOut: async () => {
      if (state.status === "signed-in") {
        const session = state.source.session();
        // Best effort: an unreachable server cannot keep the phone signed in.
        await revokeRefreshToken({
          clientId: session.clientId,
          fetch,
          refreshToken: session.refreshToken,
          revocationEndpoint: session.revocationEndpoint,
        });
      }
      await deviceSessionStore.clear();
      setState({ status: "signed-out", ended: false });
    },
    end: () => {
      setState({ status: "signed-out", ended: true });
    },
  };

  return <SessionContext value={value}>{children}</SessionContext>;
};

export const useSession = (): SessionContextValue => {
  const value = use(SessionContext);
  return value ?? panic("useSession needs a SessionProvider above it");
};
