// Orchestrates `stella auth login`: PKCE authorization-code flow against
// stella's own oauthProvider, with a loopback listener as the primary
// transport and a manual URL/code paste as the fallback for headless
// environments (see module comments in `loopback-listener.ts` and
// `manual-callback.ts`).

import { Result } from "better-result";
import { createInterface } from "node:readline/promises";

import { openInBrowser } from "./browser-open.js";
import { getRegisteredClientId, setRegisteredClientId } from "./cli-config.js";
import {
  getMcpResourceUrl,
  LOGIN_TIMEOUT_MS,
  LOOPBACK_REDIRECT_URI,
} from "./constants.js";
import {
  readCredentialFile,
  setDefaultOrg,
  upsertCredential,
  writeCredentialFile,
} from "./credential-store.js";
import type { StoredCredential } from "./credential-store.js";
import { MissingOrgClaimError } from "./errors.js";
import type { CliAuthError, LoopbackTimeoutError } from "./errors.js";
import { decodeAccessTokenClaims } from "./jwt.js";
import {
  startLoopbackListener,
  toLoopbackCallbackError,
} from "./loopback-listener.js";
import type { LoopbackCallback } from "./loopback-listener.js";
import { parseManualCallbackInput } from "./manual-callback.js";
import { registerLoopbackClient } from "./oauth-client-registration.js";
import { discoverAuthorizationServerMetadata } from "./oauth-metadata.js";
import type { AuthorizationServerMetadata } from "./oauth-metadata.js";
import { createOAuthState, createPkcePair } from "./pkce.js";
import { resolveServerUrl } from "./server-resolution.js";
import { exchangeAuthorizationCode } from "./token-exchange.js";

export type LoginOptions = {
  readonly configDir: string;
  readonly orgHint: string | undefined;
  readonly registrationScopes: readonly string[];
  readonly requestedScopes: readonly string[];
  readonly serverFlag: string | undefined;
};

export type LoginSuccess = {
  readonly serverUrl: string;
  readonly orgId: string;
  readonly grantedScopes: string;
  readonly expiresAt: number;
  readonly hasRefreshToken: boolean;
};

type Io = {
  readonly print: (line: string) => void;
  readonly promptLine: (question: string) => Promise<string>;
};

const buildIo = (process: NodeJS.Process): Io => ({
  print: (line) => {
    process.stdout.write(`${line}\n`);
  },
  promptLine: async (question) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
});

const buildAuthorizeUrl = (input: {
  authorizationEndpoint: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
}): string => {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  if (input.scopes.length > 0) {
    url.searchParams.set("scope", input.scopes.join(" "));
  }
  return url.toString();
};

/** Gets the cached loopback client id for `serverUrl`, registering one if none exists yet. */
const getOrRegisterClient = async (
  configDir: string,
  serverUrl: string,
  metadata: AuthorizationServerMetadata,
  registrationScopes: readonly string[],
): Promise<Result<string, CliAuthError>> => {
  const cached = await getRegisteredClientId(configDir, serverUrl);
  if (cached) {
    return Result.ok(cached);
  }

  const registered = await registerLoopbackClient(metadata, registrationScopes);
  if (Result.isError(registered)) {
    return registered;
  }

  await setRegisteredClientId(configDir, serverUrl, registered.value);
  return Result.ok(registered.value);
};

const isLoopbackCallback = (
  value: LoopbackCallback | LoopbackTimeoutError,
): value is LoopbackCallback => "kind" in value;

type AuthorizationCode = {
  readonly code: string;
  readonly redirectUri: string;
};

const awaitManualCode = async (
  io: Io,
  redirectUri: string,
  expectedState: string,
): Promise<Result<AuthorizationCode, CliAuthError>> => {
  const pasted = await io.promptLine("Paste the redirected URL or code: ");
  const parsed = parseManualCallbackInput(pasted);
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }

  if (parsed.value.state && parsed.value.state !== expectedState) {
    return Result.err(
      toLoopbackCallbackError({ error: "invalid_state", kind: "error" }),
    );
  }

  return Result.ok({ code: parsed.value.code, redirectUri });
};

/**
 * Waits for the loopback callback, falling back to manual paste if the
 * listener never fires. `redirectUri` must be whichever URI was actually
 * used to build the authorize request (the listener's port-specific one, or
 * the portless default when no listener could be started) — the token
 * endpoint later requires an exact match (RFC 6749 S4.1.3).
 */
const awaitAuthorizationCode = async (
  io: Io,
  authorizeUrl: string,
  redirectUri: string,
  listener: ReturnType<typeof startLoopbackListener>,
  expectedState: string,
): Promise<Result<AuthorizationCode, CliAuthError>> => {
  io.print("Opening the stella sign-in page in your browser:");
  io.print(`  ${authorizeUrl}`);
  void openInBrowser(authorizeUrl);

  if (!listener) {
    io.print(
      "Could not start a local listener; complete sign-in in any browser, then paste the redirected URL (or just the code) below.",
    );
    return awaitManualCode(io, redirectUri, expectedState);
  }

  const result = await listener.waitForCallback(LOGIN_TIMEOUT_MS);
  listener.close();

  if (!isLoopbackCallback(result)) {
    // Timed out waiting locally: the browser most likely isn't reachable
    // from this machine (SSH/remote dev/agent sandbox). Fall back to manual.
    io.print(
      "Timed out waiting for the browser. If you're running headless, complete sign-in in any browser, then paste the redirected URL (or just the code) below.",
    );
    return awaitManualCode(io, redirectUri, expectedState);
  }

  if (result.kind === "error") {
    return Result.err(toLoopbackCallbackError(result));
  }

  if (result.state !== expectedState) {
    return Result.err(
      toLoopbackCallbackError({ error: "invalid_state", kind: "error" }),
    );
  }

  return Result.ok({ code: result.code, redirectUri });
};

// Sequential steps with different Ok types chained via `Result.gen` +
// `yield* Result.await(...)` (see AGENTS.md's Error Handling conventions):
// this avoids re-wrapping every intermediate error result by hand.
export const login = async (
  process: NodeJS.Process,
  options: LoginOptions,
): Promise<Result<LoginSuccess, CliAuthError>> =>
  await Result.gen(async function* loginGen() {
    const io = buildIo(process);

    const serverUrl = yield* Result.await(
      resolveServerUrl(options.configDir, options.serverFlag),
    );
    const metadata = yield* Result.await(
      discoverAuthorizationServerMetadata(serverUrl),
    );
    const clientId = yield* Result.await(
      getOrRegisterClient(
        options.configDir,
        serverUrl,
        metadata,
        options.registrationScopes,
      ),
    );

    const { codeChallenge, codeVerifier } = createPkcePair();
    const state = createOAuthState();

    if (options.orgHint) {
      io.print(
        `If prompted to select an organization in the browser, choose: ${options.orgHint} (the CLI cannot preselect it for you; org selection happens in the browser UI).`,
      );
    }

    // Start the listener before building the authorize URL: the redirect_uri
    // sent to the authorization server must be whichever one the browser
    // will actually be redirected back to (the listener's ephemeral port, or
    // the portless default if binding failed), and it must stay identical
    // through to the token exchange.
    const listener = startLoopbackListener();
    const redirectUri = listener?.redirectUri ?? LOOPBACK_REDIRECT_URI;

    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId,
      codeChallenge,
      redirectUri,
      scopes: options.requestedScopes,
      state,
    });

    const callback = yield* Result.await(
      awaitAuthorizationCode(io, authorizeUrl, redirectUri, listener, state),
    );

    const token = yield* Result.await(
      exchangeAuthorizationCode({
        clientId,
        code: callback.code,
        codeVerifier,
        metadata,
        redirectUri: callback.redirectUri,
        resource: getMcpResourceUrl(serverUrl),
      }),
    );

    const claims = decodeAccessTokenClaims(token.access_token);
    if (!claims?.org_id) {
      return Result.err(
        new MissingOrgClaimError({
          message:
            "The access token has no org_id claim, so the CLI cannot tell which organization was granted. Re-run `stella auth login` and make sure an organization is active when you reach the consent screen.",
          serverUrl,
        }),
      );
    }

    const now = Date.now();
    const credential: StoredCredential = {
      accessToken: token.access_token,
      clientId,
      createdAt: now,
      expiresAt: now + token.expires_in * 1000,
      orgId: claims.org_id,
      ...(options.orgHint ? { orgLabel: options.orgHint } : {}),
      refreshToken: token.refresh_token,
      scope: token.scope ?? options.requestedScopes.join(" "),
      serverUrl,
      tokenType: token.token_type,
      updatedAt: now,
    };

    const existingFile = await readCredentialFile(options.configDir);
    const withCredential = upsertCredential(existingFile, credential);
    const withDefaultOrg = setDefaultOrg(
      withCredential,
      serverUrl,
      credential.orgId,
    );
    await writeCredentialFile(options.configDir, withDefaultOrg);

    return Result.ok({
      expiresAt: credential.expiresAt,
      grantedScopes: credential.scope,
      hasRefreshToken: Boolean(credential.refreshToken),
      orgId: credential.orgId,
      serverUrl,
    });
  });
