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
import type {
  AccessTokenSource,
  SessionGeneration,
} from "@/connection/session";
import { signOutSession } from "@/connection/session-actions";
import {
  type BeforeSessionEnd,
  createSessionEndBoundary,
} from "@/connection/session-end";
import { signIn as signInToServer } from "@/connection/sign-in";
import type { SignInError } from "@/connection/sign-in";
import { revokeRefreshToken } from "@/connection/tokens";
import { APP_VARIANT, PUSH_NOTIFICATIONS } from "@/env";
import { currentPushDevice } from "@/native/push-device";
import { unregisterPushDevice } from "@/state/push-devices";

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
  /**
   * Runs `handler` before any sign-out or server-ended session forgets the
   * session, at most a couple of seconds per handler; returns its removal.
   */
  readonly registerBeforeSessionEnd: (handler: BeforeSessionEnd) => () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Tells the server to stop sending to this phone, without asking the person
 * anything. Best effort: should it fail, the server stops once Apple reports
 * the token gone.
 */
const stopPushNotifications = async (source: AccessTokenSource) => {
  if (!PUSH_NOTIFICATIONS) {
    return;
  }
  const device = await currentPushDevice({ ask: false, locale: "" }).catch(
    () => null,
  );
  if (device !== null) {
    (
      await unregisterPushDevice({ fetch, source, token: device.token })
    ).unwrapOr(undefined);
  }
};

export const SessionProvider = ({ children }: React.PropsWithChildren) => {
  const restored = use(restoredSource);
  const [state, setState] = useState<SessionState>(() =>
    restored?.session() === undefined
      ? { status: "signed-out", ended: false }
      : { status: "signed-in", source: restored },
  );
  const [boundary] = useState(createSessionEndBoundary);
  // Several requests can find the same session refused at once; its
  // handlers run for the first only.
  const [ending] = useState(() => new WeakSet<AccessTokenSource>());
  const [endFailure, setEndFailure] = useState<{
    generation: SessionGeneration;
    error: unknown;
  }>();
  if (
    endFailure !== undefined &&
    deviceSessionStore.isCurrent(endFailure.generation)
  ) {
    panic(
      "Session cleanup rejected outside its handled outcomes",
      endFailure.error,
    );
  }

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
        beforeEnd: async (session) => {
          if (state.status === "signed-in") {
            ending.add(state.source);
            await boundary.run("signed-out", session);
            await stopPushNotifications(state.source);
          }
        },
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
      if (
        state.status !== "signed-in" ||
        !isCurrentSessionSource(state.source, source) ||
        ending.has(source)
      ) {
        return;
      }
      const session = source.session();
      if (session === undefined) {
        return;
      }
      const generation = deviceSessionStore.generation();
      ending.add(source);
      const signOutAfterHandlers = async () => {
        await boundary.run("ended", session);
        await stopPushNotifications(source);
        setState(
          (current) =>
            deviceSessionStore.commit(generation, () =>
              current.status === "signed-in" &&
              isCurrentSessionSource(current.source, source)
                ? ({ status: "signed-out", ended: true } as const)
                : current,
            ) ?? current,
        );
      };
      signOutAfterHandlers().catch((error: unknown) => {
        deviceSessionStore.commit(generation, () =>
          setEndFailure({ generation, error }),
        );
      });
    },
    registerBeforeSessionEnd: boundary.register,
  };

  return <SessionContext value={value}>{children}</SessionContext>;
};

export const useSession = (): SessionContextValue => {
  const value = use(SessionContext);
  return value ?? panic("useSession needs a SessionProvider above it");
};
