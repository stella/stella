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
import { isCurrentSessionSource } from "@/connection/session";
import type { AccessTokenSource } from "@/connection/session";
import { signOutSession } from "@/connection/session-actions";
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
  readonly signOut: () => Promise<Result<void, TokenError>>;
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
    restored?.session() === undefined
      ? { status: "signed-out", ended: false }
      : { status: "signed-in", source: restored },
  );

  const value: SessionContextValue = {
    state,
    signIn: async (serverUrlInput) => {
      const transition = deviceSessionStore.begin();
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
        try: async () => await transition.write(session),
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
      if (
        stored.value.type === "stale" ||
        !deviceSessionStore.isCurrent(stored.value.generation)
      ) {
        return Result.ok(undefined);
      }
      const outcome = stored.value;
      const next = {
        status: "signed-in",
        source: sourceFor({
          session,
          initialAccess: signedIn.value.access,
          generation: outcome.generation,
        }),
      } as const satisfies SessionState;
      setState(
        (current) =>
          deviceSessionStore.commit(outcome.generation, () => next) ?? current,
      );
      return Result.ok(undefined);
    },
    signOut: async () =>
      await signOutSession({
        store: deviceSessionStore,
        session:
          state.status === "signed-in" ? state.source.session() : undefined,
        revoke: async (session) => {
          (
            await revokeRefreshToken({
              clientId: session.clientId,
              fetch,
              refreshToken: session.refreshToken,
              revocationEndpoint: session.revocationEndpoint,
            })
          ).unwrapOr(undefined);
        },
        publish: (generation) =>
          setState(
            (current) =>
              deviceSessionStore.commit(
                generation,
                () => ({ status: "signed-out", ended: false }) as const,
              ) ?? current,
          ),
      }),
    end: (source) => {
      const generation = deviceSessionStore.generation();
      setState(
        (current) =>
          deviceSessionStore.commit(generation, () =>
            current.status === "signed-in" &&
            isCurrentSessionSource(current.source, source)
              ? ({ status: "signed-out", ended: true } as const)
              : current,
          ) ?? current,
      );
    },
  };

  return <SessionContext value={value}>{children}</SessionContext>;
};

export const useSession = (): SessionContextValue => {
  const value = use(SessionContext);
  return value ?? panic("useSession needs a SessionProvider above it");
};
