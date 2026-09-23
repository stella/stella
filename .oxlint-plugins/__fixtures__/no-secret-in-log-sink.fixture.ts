// Passive regression fixture for `no-secret-in-log-sink/no-secret-in-log-sink`.

import { maskApiKey as foreignMask } from "unrelated-mask";

import { maskApiKey, maskApiKey as mask } from "@/api/lib/ai-config-crypto";

type Sink = (...values: unknown[]) => void;

declare const apiKey: string;
declare const bearerToken: string;
declare const cookie: string;
declare const password: string;
declare const session_token: string;
declare const token: string;
declare const authorizationHeader: string;
declare const credentials: { clientSecret: string };
declare const error: unknown;
declare const captureError: Sink;
declare const logger: Record<"error" | "info" | "warn", Sink>;
declare const Sentry: Record<
  "addBreadcrumb" | "captureException" | "setContext",
  Sink
>;
declare const scope: { setExtra: Sink };
declare const span: { setAttribute: Sink; setAttributes: Sink };
declare const analytics: { capture: Sink };
declare const inputTokens: number;
declare const tokenCount: number;
declare const cookieName: string;
declare class HandlerError extends Error {
  constructor(options: { message: string; cause: unknown });
}

// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: secret object key in a serialization sink
export const serializedSecret = JSON.stringify({ apiKey });
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: nested secret key
export const nestedSecret = JSON.stringify({ config: { password } });
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: member access in a telemetry sink
captureError(error, credentials.clientSecret);
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: Error constructor template
export const secretError = new Error(`provider failed: ${apiKey}`);
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink, unicorn/new-for-builtins -- fixture: Error called without new
export const calledError = Error(`provider failed: ${apiKey}`);
export const taggedError = new HandlerError({
  message: "provider failed",
  // oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: tagged error cause
  cause: { clientSecret: credentials.clientSecret },
});
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: snake-case name
logger.info("refresh", session_token);
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: upper-case object key
logger.warn({ API_KEY: apiKey.trim() });
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: environment read under a KEY name
logger.error(process.env.STRIPE_KEY);
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: Bun environment read
logger.error(`deploy ${Bun.env.DEPLOY_KEY}`);

const { warn } = console;
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: destructured console method
warn(token);
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink, typescript/dot-notation, no-console -- fixture: computed console method
console["error"](authorizationHeader);
// oxlint-disable-next-line no-console -- fixture: aliased console method
const print = console.log;
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: aliased console method
print(cookie);

// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: Sentry context
Sentry.setContext("auth", { bearerToken });
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: Sentry breadcrumb data
Sentry.addBreadcrumb({ data: { password } });
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: Sentry extra on captureException
Sentry.captureException(error, { extra: { token } });
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: scope extra
scope.setExtra("key", apiKey);
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: span attribute
span.setAttribute("auth", bearerToken);
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: span attributes
span.setAttributes({ password });
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: analytics capture properties
analytics.capture({ event: "connected", properties: { apiKey } });

const secretAlias = credentials.clientSecret;
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: stable local alias
logger.error(secretAlias);

// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture: a same-named export of another module is not the masking helper
export const foreignMasked = JSON.stringify({ apiKey: foreignMask(apiKey) });

// expect-clean: no-secret-in-log-sink/no-secret-in-log-sink
export const serializedConfig = JSON.stringify({ provider: "example" });
// expect-clean: no-secret-in-log-sink/no-secret-in-log-sink
export const maskedKey = JSON.stringify({ apiKey: maskApiKey(apiKey) });
// expect-clean: no-secret-in-log-sink/no-secret-in-log-sink
export const aliasMaskedKey = JSON.stringify({ apiKey: mask(apiKey) });
// expect-clean: no-secret-in-log-sink/no-secret-in-log-sink
logger.info("usage", { inputTokens, tokenCount, cookieName });
// expect-clean: no-secret-in-log-sink/no-secret-in-log-sink
logger.info({ hasApiKey: Boolean(apiKey), keyLength: apiKey.length });
// expect-clean: no-secret-in-log-sink/no-secret-in-log-sink
logger.info({ configured: apiKey !== "" });
