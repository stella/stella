import { createContext, use, useState } from "react";

import { panic, Result } from "better-result";

import { apiOAuthResourceUrl } from "@stll/api-contract/api-oauth-resource";
import { mobileRedirectUri } from "@stll/api-contract/mobile-client";

import { epochMilliseconds } from "@/connection/clock";
import { TokenError } from "@/connection/errors";
import {
  deviceCrypto,
  deviceSessionStore,
  openDeviceAuthSession,
} from "@/connection/platform";
import { restoredSource, sourceFor } from "@/connection/restored-session";
import type { AccessTokenSource } from "@/connection/session";
import { signIn as signInToServer } from "@/connection/sign-in";
import type { SignInError } from "@/connection/sign-in";
import { revokeRefreshToken } from "@/connection/tokens";
import { APP_VARIANT } from "@/env";

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
  /**
   * The server refused `source`'s session; the person has to sign in again.
   * A source left over from an earlier sign-in ends nothing.
   */
  readonly end: (source: AccessTokenSource) => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export const SessionProvider = ({ children }: React.PropsWithChildren) => {
  const restored = use(restoredSource);
  const [state, setState] = useState<SessionState>(() =>
    restored === undefined
      ? { status: "signed-out", ended: false }
      : { status: "signed-in", source: restored },
  );

  const value: SessionContextValue = {
    state,
    signIn: async (serverUrlInput) => {
      const signedIn = await signInToServer({
        crypto: deviceCrypto,
        fetch,
        now: epochMilliseconds,
        openAuthSession: openDeviceAuthSession,
        redirectUri: mobileRedirectUri(APP_VARIANT),
        resourceFor: apiOAuthResourceUrl,
        serverUrlInput,
        // Plain http to a simulator host is for development builds only.
        transport: { allowPlainHttp: __DEV__ },
      });
      if (Result.isError(signedIn)) {
        return Result.err(signedIn.error);
      }
      const { session } = signedIn.value;
      const stored = await Result.tryPromise({
        try: async () => {
          await deviceSessionStore.write(session);
        },
        catch: (cause) =>
          new TokenError({
            message: "The keychain refused the session",
            cause,
          }),
      });
      if (Result.isError(stored)) {
        // A grant the phone cannot keep is one nobody can use; give it back.
        // Sign-in fails either way, and an unrevoked grant expires unused.
        (
          await revokeRefreshToken({
            clientId: session.clientId,
            fetch,
            refreshToken: session.refreshToken,
            revocationEndpoint: session.revocationEndpoint,
          })
        ).unwrapOr(undefined);
        return Result.err(stored.error);
      }
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
        (
          await revokeRefreshToken({
            clientId: session.clientId,
            fetch,
            refreshToken: session.refreshToken,
            revocationEndpoint: session.revocationEndpoint,
          })
        ).unwrapOr(undefined);
      }
      // The refresh token is revoked already, so a session the keychain
      // keeps fails its first refresh and ends; signing out still happens.
      (
        await Result.tryPromise(async () => {
          await deviceSessionStore.clear();
        })
      ).unwrapOr(undefined);
      setState({ status: "signed-out", ended: false });
    },
    end: (source) => {
      setState((current) =>
        current.status === "signed-in" && current.source === source
          ? { status: "signed-out", ended: true }
          : current,
      );
    },
  };

  return <SessionContext value={value}>{children}</SessionContext>;
};

export const useSession = (): SessionContextValue => {
  const value = use(SessionContext);
  return value ?? panic("useSession needs a SessionProvider above it");
};
