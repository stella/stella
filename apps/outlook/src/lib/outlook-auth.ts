// The task pane's sign-in: OAuth 2 authorization code with PKCE as a public
// client (`@stll/api-contract/outlook-client`), approved in an Office dialog.
// See `lib/oauth/authorize.ts` for the dialog round trip and
// `lib/oauth/grant-store.ts` for what is kept where.

import { Result } from "better-result";

import { apiOAuthResourceUrl } from "@stll/api-contract/api-oauth-resource";
import { outlookRedirectUri } from "@stll/api-contract/outlook-client";
import { Temporal } from "@stll/time";

import { apiFetchUrl, env } from "@/env";
import {
  buildAuthorizeUrl,
  buildDialogStartUrl,
  readCallbackMessage,
} from "@/lib/oauth/authorize";
import {
  type AuthorizationServerMetadata,
  discoverAuthorizationServer,
  type Fetch,
  resolveClientId,
  type TransportPolicy,
} from "@/lib/oauth/discovery";
import { SignInError } from "@/lib/oauth/errors";
import {
  createGrantStore,
  type GrantStore,
  type KeyValueStorage,
  type StoredGrant,
} from "@/lib/oauth/grant-store";
import {
  createAuthorizationState,
  createPkcePair,
  type PkcePair,
} from "@/lib/oauth/pkce";
import {
  isDeadGrant,
  redeemAuthorizationCode,
  refreshTokens,
  revokeRefreshToken,
} from "@/lib/oauth/tokens";
import { getOfficeRuntime } from "@/lib/office";
import { openOfficeSignInDialog } from "@/lib/office-dialog";

/** Refresh a little before expiry so a request never leaves with a stale token. */
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

export type AuthStatus = "signed-in" | "signed-out";

export type DialogAnswer = {
  readonly message: string;
  readonly origin: string | undefined;
};

export type OpenSignInDialog = (options: {
  readonly promptBeforeOpen: boolean;
  readonly startUrl: string;
}) => Promise<DialogAnswer>;

/** One sign-in attempt, ready before the click so the dialog opens at once. */
export type PreparedSignIn = {
  readonly clientId: string;
  readonly metadata: AuthorizationServerMetadata;
  readonly pkce: PkcePair;
  readonly redirectUri: string;
  readonly resource: string;
  readonly startUrl: string;
  readonly state: string;
};

type AccessToken = { readonly expiresAt: number; readonly token: string };

export type OutlookAuthDependencies = {
  readonly apiOrigin: string;
  readonly fetch: Fetch;
  readonly grantStore: GrantStore;
  readonly now: () => number;
  readonly openDialog: OpenSignInDialog;
  readonly policy: TransportPolicy;
  readonly taskPaneOrigin: string;
};

type PrepareSignInOptions = Pick<
  OutlookAuthDependencies,
  "apiOrigin" | "fetch" | "policy" | "taskPaneOrigin"
>;

/** Discovery, client id, PKCE and state for one sign-in attempt. */
const prepareOutlookSignIn = async ({
  apiOrigin,
  fetch,
  policy,
  taskPaneOrigin,
}: PrepareSignInOptions): Promise<Result<PreparedSignIn, SignInError>> =>
  await Result.gen(async function* () {
    const metadata = yield* Result.await(
      discoverAuthorizationServer({ apiOrigin, fetch, policy }),
    );
    const resource = apiOAuthResourceUrl(apiOrigin);
    const redirectUri = outlookRedirectUri(taskPaneOrigin);
    const clientId = yield* Result.await(
      resolveClientId({ fetch, metadata, redirectUri, resource }),
    );
    const pkce = await createPkcePair();
    const state = createAuthorizationState();
    const startUrl = buildDialogStartUrl({
      authorizeUrl: buildAuthorizeUrl({
        authorizationEndpoint: metadata.authorization_endpoint,
        clientId,
        codeChallenge: pkce.codeChallenge,
        redirectUri,
        resource,
        state,
      }),
      taskPaneOrigin,
    });
    return Result.ok({
      clientId,
      metadata,
      pkce,
      redirectUri,
      resource,
      startUrl,
      state,
    });
  });

type RedeemedSignIn = {
  /** Null when the server issued no refresh token. */
  readonly grant: StoredGrant | null;
  readonly token: AccessToken;
};

type RedeemDialogAnswerOptions = Pick<
  OutlookAuthDependencies,
  "fetch" | "now" | "taskPaneOrigin"
> & {
  readonly answer: DialogAnswer;
  readonly prepared: PreparedSignIn;
};

/** Check the dialog's answer against the attempt and redeem its code. */
const redeemDialogAnswer = async ({
  answer,
  fetch,
  now,
  prepared,
  taskPaneOrigin,
}: RedeemDialogAnswerOptions): Promise<Result<RedeemedSignIn, SignInError>> => {
  const { metadata } = prepared;
  const code = readCallbackMessage({
    expectedIssuer: metadata.issuer,
    expectedOrigin: taskPaneOrigin,
    expectedState: prepared.state,
    issuerRequired:
      metadata.authorization_response_iss_parameter_supported === true,
    origin: answer.origin,
    raw: answer.message,
  });
  if (Result.isError(code)) {
    return Result.err(code.error);
  }
  const tokens = await redeemAuthorizationCode({
    clientId: prepared.clientId,
    code: code.value,
    codeVerifier: prepared.pkce.codeVerifier,
    fetch,
    redirectUri: prepared.redirectUri,
    resource: prepared.resource,
    tokenEndpoint: metadata.token_endpoint,
  });
  if (Result.isError(tokens)) {
    return Result.err(
      new SignInError({
        message: tokens.error.message,
        failure: "token",
        cause: tokens.error,
      }),
    );
  }
  const refreshToken = tokens.value.refresh_token;
  return Result.ok({
    grant:
      refreshToken === undefined
        ? null
        : {
            clientId: prepared.clientId,
            issuer: metadata.issuer,
            refreshToken,
            resource: prepared.resource,
            ...(metadata.revocation_endpoint === undefined
              ? {}
              : { revocationEndpoint: metadata.revocation_endpoint }),
            tokenEndpoint: metadata.token_endpoint,
          },
    token: {
      expiresAt: now() + tokens.value.expires_in * 1000,
      token: tokens.value.access_token,
    },
  });
};

export const createOutlookAuth = ({
  apiOrigin,
  fetch,
  grantStore,
  now,
  openDialog,
  policy,
  taskPaneOrigin,
}: OutlookAuthDependencies) => {
  let grant: StoredGrant | null = grantStore.read();
  let access: AccessToken | null = null;
  let status: AuthStatus = grant ? "signed-in" : "signed-out";
  let refreshing: Promise<string | null> | null = null;
  const subscribers = new Set<(status: AuthStatus) => void>();

  const setStatus = (next: AuthStatus) => {
    if (next === status) {
      return;
    }
    status = next;
    for (const subscriber of subscribers) {
      subscriber(next);
    }
  };

  const keep = (next: StoredGrant, token: AccessToken) => {
    grant = next;
    access = token;
    grantStore.write(next);
    setStatus("signed-in");
  };

  /** Forget the grant locally: the pane shows the sign-in screen again. */
  const forget = () => {
    grant = null;
    access = null;
    grantStore.clear();
    setStatus("signed-out");
  };

  /**
   * Opens the dialog before awaiting anything, so a click handler that calls
   * this keeps the user gesture Outlook on the web needs for a popup.
   */
  const signIn = async (
    prepared: PreparedSignIn,
    { promptBeforeOpen }: { readonly promptBeforeOpen: boolean },
  ): Promise<Result<void, SignInError>> => {
    const answered = openDialog({
      promptBeforeOpen,
      startUrl: prepared.startUrl,
    });
    const answer = await Result.tryPromise({
      try: async () => await answered,
      catch: (cause) =>
        cause instanceof SignInError
          ? cause
          : new SignInError({
              message: "The sign-in dialog failed",
              failure: "unavailable",
              cause,
            }),
    });
    if (Result.isError(answer)) {
      return Result.err(answer.error);
    }
    const redeemed = await redeemDialogAnswer({
      answer: answer.value,
      fetch,
      now,
      prepared,
      taskPaneOrigin,
    });
    if (Result.isError(redeemed)) {
      return Result.err(redeemed.error);
    }
    const { grant: redeemedGrant, token } = redeemed.value;
    if (redeemedGrant === null) {
      // Without `offline_access` granted the session ends with this token.
      grant = null;
      grantStore.clear();
      access = token;
      setStatus("signed-in");
      return Result.ok(undefined);
    }
    keep(redeemedGrant, token);
    return Result.ok(undefined);
  };

  const runRefresh = async (): Promise<string | null> => {
    // Another task pane of this origin may have rotated the token since this
    // one read it; the stored grant is the current one.
    const current = grantStore.read() ?? grant;
    if (current === null) {
      forget();
      return null;
    }
    const refreshed = await refreshTokens({
      clientId: current.clientId,
      fetch,
      refreshToken: current.refreshToken,
      resource: current.resource,
      tokenEndpoint: current.tokenEndpoint,
    });
    if (Result.isError(refreshed)) {
      if (isDeadGrant(refreshed.error)) {
        forget();
        return null;
      }
      throw refreshed.error;
    }
    const token = {
      expiresAt: now() + refreshed.value.expires_in * 1000,
      token: refreshed.value.access_token,
    };
    keep(
      {
        ...current,
        refreshToken: refreshed.value.refresh_token ?? current.refreshToken,
      },
      token,
    );
    return token.token;
  };

  /** One refresh at a time; concurrent callers share its outcome. */
  const refresh = async (): Promise<string | null> => {
    refreshing ??= runRefresh().finally(() => {
      refreshing = null;
    });
    return await refreshing;
  };

  /**
   * A usable access token, refreshing it when it is about to expire. Null
   * when the pane is signed out. Throws when a refresh could not reach the
   * server, which leaves the grant in place for a later attempt.
   */
  const getAccessToken = async (): Promise<string | null> => {
    if (
      access !== null &&
      access.expiresAt - ACCESS_TOKEN_EXPIRY_SKEW_MS > now()
    ) {
      return access.token;
    }
    if (grant === null && grantStore.read() === null) {
      if (access !== null) {
        // A session without a refresh token ends with its access token.
        forget();
      }
      return null;
    }
    return await refresh();
  };

  /**
   * After the API refused `rejected`: refresh once (or reuse a token another
   * request already refreshed to). Null means the person must sign in again.
   */
  const refreshAfterUnauthorized = async (
    rejected: string,
  ): Promise<string | null> => {
    if (access !== null && access.token !== rejected) {
      return access.token;
    }
    access = null;
    return await getAccessToken();
  };

  /** Revoke the grant when the server offers revocation, then forget it. */
  const signOut = async (): Promise<void> => {
    const current = grantStore.read() ?? grant;
    forget();
    if (current === null) {
      return;
    }
    await revokeRefreshToken({
      clientId: current.clientId,
      fetch,
      refreshToken: current.refreshToken,
      revocationEndpoint: current.revocationEndpoint,
    });
  };

  return {
    forget,
    getAccessToken,
    getStatus: (): AuthStatus => status,
    prepareSignIn: async () =>
      await prepareOutlookSignIn({ apiOrigin, fetch, policy, taskPaneOrigin }),
    refreshAfterUnauthorized,
    signIn,
    signOut,
    subscribe: (subscriber: (status: AuthStatus) => void): (() => void) => {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
};

export type OutlookAuth = ReturnType<typeof createOutlookAuth>;

const isKeyValueStorage = (value: unknown): value is KeyValueStorage =>
  typeof value === "object" &&
  value !== null &&
  "getItem" in value &&
  "setItem" in value &&
  "removeItem" in value;

/** The origin's localStorage, or null where it is missing or blocked. */
const browserStorage = (): KeyValueStorage | null => {
  const storage = Result.try((): unknown =>
    Reflect.get(globalThis, "localStorage"),
  );
  return Result.isOk(storage) && isKeyValueStorage(storage.value)
    ? storage.value
    : null;
};

const createDefaultAuth = (): OutlookAuth =>
  createOutlookAuth({
    apiOrigin: env.apiOrigin,
    fetch: async (input, init) => await fetch(apiFetchUrl(input), init),
    grantStore: createGrantStore({
      partitionKey: getOfficeRuntime()?.context.partitionKey,
      storage: browserStorage(),
    }),
    now: () => Temporal.Now.instant().epochMilliseconds,
    openDialog: openOfficeSignInDialog,
    policy: { allowLoopbackHttp: env.buildEnvironment === "dev" },
    taskPaneOrigin: env.taskpaneOrigin,
  });

let defaultAuth: OutlookAuth | null = null;

/**
 * The task pane's auth state. Created on first use, after Office has
 * initialized, so the storage partition key is known.
 */
export const outlookAuth = (): OutlookAuth => {
  defaultAuth ??= createDefaultAuth();
  return defaultAuth;
};
