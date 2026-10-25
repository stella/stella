import { Result, TaggedError } from "better-result";
/**
 * KSeF 2.0 online-session protocol client.
 *
 * Persist the returned session and invoice references before continuing. Never
 * resend after an unknown outcome: KSeF deduplicates by seller NIP, invoice
 * type, and invoice number, and reports the original invoice as status 440.
 */
import { X509Certificate } from "node:crypto";
import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { sha256Base64, sha256Base64Url } from "@stll/sha256/bun";

import { KSEF_FA3_FORM_CODE } from "../exports/ksef-fa3";

export type KsefEnvironment = "test" | "demo" | "production";

const API_URLS = {
  test: "https://api-test.ksef.mf.gov.pl/v2",
  demo: "https://api-demo.ksef.mf.gov.pl/v2",
  production: "https://api.ksef.mf.gov.pl/v2",
} as const satisfies Record<KsefEnvironment, string>;
const QR_URLS = {
  test: "https://qr-test.ksef.mf.gov.pl",
  demo: "https://qr-demo.ksef.mf.gov.pl",
  production: "https://qr.ksef.mf.gov.pl",
} as const satisfies Record<KsefEnvironment, string>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_INVOICE_BYTES = 1_000_000;

export type KsefTransport = (request: {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}) => Promise<{ status: number; headers: Headers; body: Uint8Array }>;

export type KsefErrorKind =
  | "invalid_response"
  | "invalid_input"
  | "no_valid_certificate"
  | "rate_limited"
  | "unavailable"
  | "unauthorized"
  | "authentication_failed"
  | "unknown_status";
export class KsefError extends TaggedError("KsefError")<{
  kind: KsefErrorKind;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  statusCode?: number;
}> {}
export type KsefResult<T> = Result<T, KsefError>;

type Clock = {
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
};
const defaultClock: Clock = {
  now: () => new Date(),
  sleep: async (milliseconds) => Bun.sleep(milliseconds),
};
type Token = { token: string; validUntil: string };
export type Authenticator = {
  getAccessToken: () => Promise<KsefResult<string>>;
};

const error = (
  kind: KsefErrorKind,
  message: string,
  retryable: boolean,
  details: { retryAfterSeconds?: number; statusCode?: number } = {},
) => new KsefError({ kind, message, retryable, ...details });
const invalidResponse = (message: string) =>
  error("invalid_response", message, false);
const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");
const jsonBytes = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

const parseJson = (bytes: Uint8Array): KsefResult<unknown> =>
  Result.try({
    try: (): unknown => JSON.parse(decoder.decode(bytes)),
    catch: () =>
      invalidResponse(
        "KSeF returned an unreadable response; retry the operation or contact KSeF support.",
      ),
  });
const parseResponse = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  bytes: Uint8Array,
  schema: TSchema,
  message: string,
): KsefResult<v.InferOutput<TSchema>> =>
  parseJson(bytes).andThen((json) => {
    const parsed = v.safeParse(schema, json);
    return parsed.success
      ? Result.ok(parsed.output)
      : Result.err(invalidResponse(message));
  });

const errorResponseSchema = v.object({
  detail: v.optional(v.string()),
  description: v.optional(v.string()),
  exception: v.optional(
    v.array(v.object({ exceptionDescription: v.optional(v.string()) })),
  ),
});
const responseDescription = (body: Uint8Array): string | undefined => {
  const parsed = parseResponse(
    body,
    errorResponseSchema,
    "Invalid error response.",
  );
  if (parsed.isErr()) {
    return undefined;
  }
  return (
    parsed.value.detail ??
    parsed.value.description ??
    parsed.value.exception?.at(0)?.exceptionDescription
  );
};

type RequestOptions = {
  transport: KsefTransport;
  environment: KsefEnvironment;
  method: "GET" | "POST";
  path: string;
  token?: string;
  body?: unknown;
  /** The UPO is signed XML; every other KSeF response is JSON. */
  accept?: "application/json" | "application/xml";
};
const request = async ({
  transport,
  environment,
  method,
  path,
  token,
  body,
  accept = "application/json",
}: RequestOptions): Promise<KsefResult<Awaited<ReturnType<KsefTransport>>>> => {
  const attempted = await Result.tryPromise({
    try: async () =>
      await transport({
        method,
        url: `${API_URLS[environment]}${path}`,
        headers: {
          Accept: accept,
          "Content-Type": "application/json",
          "X-Error-Format": "problem-details",
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: jsonBytes(body) }),
      }),
    catch: () =>
      error(
        "unavailable",
        "KSeF could not be reached; retry the operation without resending an invoice whose outcome is unknown.",
        true,
      ),
  });
  if (attempted.isErr()) {
    return Result.err(attempted.error);
  }
  const response = attempted.value;
  if (response.status >= 200 && response.status < 300) {
    return Result.ok(response);
  }
  if (response.status === 429) {
    // KSeF states the wait in whole seconds; without one the caller backs off.
    const retryAfter = parseIntegerToken(
      response.headers.get("Retry-After")?.trim(),
      { sign: "unsigned" },
    );
    return Result.err(
      retryAfter.isOk()
        ? error(
            "rate_limited",
            `KSeF rate limit was reached; retry after ${retryAfter.value} seconds.`,
            true,
            { retryAfterSeconds: retryAfter.value, statusCode: 429 },
          )
        : error(
            "rate_limited",
            "KSeF rate limit was reached; retry later with a growing delay.",
            true,
            { statusCode: 429 },
          ),
    );
  }
  if (response.status >= 500) {
    return Result.err(
      error(
        "unavailable",
        "KSeF is temporarily unavailable; retry the operation without resending an invoice whose outcome is unknown.",
        true,
        { statusCode: response.status },
      ),
    );
  }
  if (response.status === 401 || response.status === 403) {
    const permission = responseDescription(response.body)?.includes(
      "InvoiceWrite",
    )
      ? " The InvoiceWrite permission is required."
      : "";
    return Result.err(
      error(
        "unauthorized",
        `KSeF refused authorization.${permission} Re-authenticate or ask an administrator to grant the required permission.`,
        false,
        { statusCode: response.status },
      ),
    );
  }
  return Result.err(
    error(
      "invalid_response",
      `KSeF rejected the request with HTTP ${response.status}; correct the request using the KSeF response and try again.`,
      false,
      { statusCode: response.status },
    ),
  );
};

type CertificateUsage = "KsefTokenEncryption" | "SymmetricKeyEncryption";
const certificateResponseSchema = v.array(
  v.object({
    certificate: v.string(),
    publicKeyId: v.string(),
    validFrom: v.string(),
    validTo: v.string(),
    usage: v.array(v.string()),
  }),
);
const certificateFor = async (
  transport: KsefTransport,
  environment: KsefEnvironment,
  usage: CertificateUsage,
  now: Date,
) => {
  const requested = await request({
    transport,
    environment,
    method: "GET",
    path: "/security/public-key-certificates",
  });
  if (requested.isErr()) {
    return Result.err(requested.error);
  }
  const parsed = parseResponse(
    requested.value.body,
    certificateResponseSchema,
    "KSeF returned invalid certificate metadata; refresh certificates or contact KSeF support.",
  );
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const match = parsed.value.find(
    (item) =>
      item.usage.includes(usage) &&
      new Date(item.validFrom) <= now &&
      now <= new Date(item.validTo),
  );
  return match === undefined
    ? Result.err(
        error(
          "no_valid_certificate",
          `KSeF has no currently valid ${usage} certificate; refresh certificates later or contact KSeF support.`,
          false,
        ),
      )
    : Result.ok(match);
};

const importRsaPublicKey = async (
  certificate: string,
): Promise<KsefResult<CryptoKey>> => {
  const parsed = Result.try({
    try: () => new X509Certificate(Buffer.from(certificate, "base64")),
    catch: () =>
      invalidResponse(
        "KSeF supplied an invalid encryption certificate; refresh certificates or contact KSeF support.",
      ),
  });
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const spki = parsed.value.publicKey.export({ type: "spki", format: "der" });
  return await Result.tryPromise({
    try: async () =>
      await crypto.subtle.importKey(
        "spki",
        spki,
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["encrypt"],
      ),
    catch: () =>
      invalidResponse(
        "KSeF supplied an invalid encryption certificate; refresh certificates or contact KSeF support.",
      ),
  });
};
const rsaEncrypt = async (
  certificate: string,
  plaintext: Uint8Array,
): Promise<KsefResult<Uint8Array>> => {
  const imported = await importRsaPublicKey(certificate);
  if (imported.isErr()) {
    return Result.err(imported.error);
  }
  return await Result.tryPromise({
    try: async () =>
      new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "RSA-OAEP" },
          imported.value,
          Buffer.from(plaintext),
        ),
      ),
    catch: () =>
      invalidResponse(
        "KSeF supplied an unusable encryption certificate; refresh certificates or contact KSeF support.",
      ),
  });
};

type KsefTokenAuthenticatorOptions = {
  environment: KsefEnvironment;
  transport: KsefTransport;
  nip: string;
  ksefToken: string;
  clock?: Clock;
  polling?: { maxAttempts: number; delayMilliseconds: number };
  refreshMarginMilliseconds?: number;
};
const challengeSchema = v.object({
  challenge: v.string(),
  timestamp: v.string(),
  // The token nonce: milliseconds since the epoch, as KSeF states them.
  timestampMs: v.pipe(v.number(), v.integer()),
});
const authenticationStartSchema = v.object({
  referenceNumber: v.string(),
  authenticationToken: v.object({ token: v.string(), validUntil: v.string() }),
});
const authenticationStatusSchema = v.object({
  status: v.object({ code: v.number(), description: v.optional(v.string()) }),
});
const tokenSchema = v.object({ token: v.string(), validUntil: v.string() });
const redeemedTokensSchema = v.object({
  accessToken: tokenSchema,
  refreshToken: tokenSchema,
});
const refreshedTokenSchema = v.object({ accessToken: tokenSchema });

const refreshAccessToken = async (
  options: KsefTokenAuthenticatorOptions,
  refreshToken: Token,
): Promise<KsefResult<Token>> => {
  const response = await request({
    transport: options.transport,
    environment: options.environment,
    method: "POST",
    path: "/auth/token/refresh",
    token: refreshToken.token,
    body: {},
  });
  if (response.isErr()) {
    return Result.err(response.error);
  }
  const refreshed = parseResponse(
    response.value.body,
    refreshedTokenSchema,
    "KSeF token refresh omitted validity data; authenticate again.",
  );
  return refreshed.isErr()
    ? Result.err(refreshed.error)
    : Result.ok(refreshed.value.accessToken);
};

export const createKsefTokenAuthenticator = (
  options: KsefTokenAuthenticatorOptions,
): Authenticator => {
  const clock = options.clock ?? defaultClock;
  const polling = options.polling ?? {
    maxAttempts: 20,
    delayMilliseconds: 500,
  };
  const refreshMargin = options.refreshMarginMilliseconds ?? 60_000;
  let tokens: { accessToken: Token; refreshToken: Token } | undefined;

  const login = async (): Promise<
    KsefResult<{ accessToken: Token; refreshToken: Token }>
  > => {
    const challengeResponse = await request({
      transport: options.transport,
      environment: options.environment,
      method: "POST",
      path: "/auth/challenge",
      body: {},
    });
    if (challengeResponse.isErr()) {
      return Result.err(challengeResponse.error);
    }
    const challenge = parseResponse(
      challengeResponse.value.body,
      challengeSchema,
      "KSeF challenge omitted required fields; retry authentication.",
    );
    if (challenge.isErr()) {
      return Result.err(challenge.error);
    }
    const certificate = await certificateFor(
      options.transport,
      options.environment,
      "KsefTokenEncryption",
      clock.now(),
    );
    if (certificate.isErr()) {
      return Result.err(certificate.error);
    }
    const encryptedToken = await rsaEncrypt(
      certificate.value.certificate,
      encoder.encode(`${options.ksefToken}|${challenge.value.timestampMs}`),
    );
    if (encryptedToken.isErr()) {
      return Result.err(encryptedToken.error);
    }
    const initResponse = await request({
      transport: options.transport,
      environment: options.environment,
      method: "POST",
      path: "/auth/ksef-token",
      body: {
        challenge: challenge.value.challenge,
        contextIdentifier: { type: "Nip", value: options.nip },
        encryptedToken: base64(encryptedToken.value),
        publicKeyId: certificate.value.publicKeyId,
      },
    });
    if (initResponse.isErr()) {
      return Result.err(initResponse.error);
    }
    const init = parseResponse(
      initResponse.value.body,
      authenticationStartSchema,
      "KSeF authentication start omitted required fields; retry authentication.",
    );
    if (init.isErr()) {
      return Result.err(init.error);
    }
    let authenticated = false;
    for (let attempt = 0; attempt < polling.maxAttempts; attempt += 1) {
      const statusResponse = await request({
        transport: options.transport,
        environment: options.environment,
        method: "GET",
        path: `/auth/${encodeURIComponent(init.value.referenceNumber)}`,
        token: init.value.authenticationToken.token,
      });
      if (statusResponse.isErr()) {
        return Result.err(statusResponse.error);
      }
      const status = parseResponse(
        statusResponse.value.body,
        authenticationStatusSchema,
        "KSeF returned an invalid authentication status; retry authentication.",
      );
      if (status.isErr()) {
        return Result.err(status.error);
      }
      if (status.value.status.code === 200) {
        authenticated = true;
        break;
      }
      if (status.value.status.code !== 100) {
        return Result.err(
          error(
            "authentication_failed",
            `KSeF authentication failed with status ${status.value.status.code}; verify the KSeF token, NIP, and permissions.`,
            false,
            { statusCode: status.value.status.code },
          ),
        );
      }
      const slept = await Result.tryPromise({
        try: async () =>
          await clock.sleep(polling.delayMilliseconds * (attempt + 1)),
        catch: () =>
          error(
            "authentication_failed",
            "KSeF authentication polling was interrupted; retry authentication.",
            true,
          ),
      });
      if (slept.isErr()) {
        return Result.err(slept.error);
      }
    }
    if (!authenticated) {
      return Result.err(
        error(
          "authentication_failed",
          "KSeF authentication did not finish in time; retry status polling before starting a new login.",
          true,
        ),
      );
    }
    const redeemResponse = await request({
      transport: options.transport,
      environment: options.environment,
      method: "POST",
      path: "/auth/token/redeem",
      token: init.value.authenticationToken.token,
      body: {},
    });
    if (redeemResponse.isErr()) {
      return Result.err(redeemResponse.error);
    }
    return parseResponse(
      redeemResponse.value.body,
      redeemedTokensSchema,
      "KSeF token redemption omitted token validity data; retry authentication.",
    );
  };

  const expiresSoon = (token: Token) =>
    new Date(token.validUntil).getTime() - clock.now().getTime() <=
    refreshMargin;

  // A new login replaces whatever the authenticator held; a failed one leaves
  // nothing cached, so the next call starts from a fresh login again.
  const loginAgain = async () => {
    tokens = undefined;
    const loggedIn = await login();
    if (loggedIn.isOk()) {
      tokens = loggedIn.value;
    }
    return loggedIn;
  };

  return {
    getAccessToken: async () => {
      let current = tokens;
      if (current === undefined || expiresSoon(current.refreshToken)) {
        const loggedIn = await loginAgain();
        if (loggedIn.isErr()) {
          return Result.err(loggedIn.error);
        }
        current = loggedIn.value;
      }
      if (!expiresSoon(current.accessToken)) {
        return Result.ok(current.accessToken.token);
      }
      const { refreshToken } = current;
      const refreshed = await refreshAccessToken(options, refreshToken);
      if (refreshed.isErr()) {
        // KSeF answers 401 to a revoked refresh token: only a new login helps.
        if (refreshed.error.statusCode !== 401) {
          return Result.err(refreshed.error);
        }
        const loggedIn = await loginAgain();
        return loggedIn.isErr()
          ? Result.err(loggedIn.error)
          : Result.ok(loggedIn.value.accessToken.token);
      }
      tokens = { accessToken: refreshed.value, refreshToken };
      return Result.ok(refreshed.value.token);
    },
  };
};

export type OnlineSession = {
  sessionReferenceNumber: string;
  validUntil: string;
  key: CryptoKey;
  iv: Uint8Array;
};
export type SentInvoice = {
  sessionReferenceNumber: string;
  invoiceReferenceNumber: string;
};
export type KsefInvoiceStatus =
  | { status: "processing"; code: 100 | 150; description: string }
  | { status: "accepted"; code: 200; description: string; ksefNumber: string }
  | { status: "duplicate"; code: 440; description: string; ksefNumber: string }
  | { status: "rejected"; code: number; description: string };
type ClientOptions = {
  environment: KsefEnvironment;
  transport: KsefTransport;
  authenticator: Authenticator;
  clock?: Clock;
};
const sessionResponseSchema = v.object({
  referenceNumber: v.string(),
  validUntil: v.string(),
});
const invoiceResponseSchema = v.object({ referenceNumber: v.string() });
// SessionInvoiceStatusResponse: an accepted invoice's number is top-level
// `ksefNumber`; a duplicate (440) names the original in
// `status.extensions.originalKsefNumber`.
const invoiceStatusSchema = v.object({
  status: v.object({
    code: v.number(),
    description: v.optional(v.string()),
    extensions: v.nullish(
      v.object({ originalKsefNumber: v.nullish(v.string()) }),
    ),
  }),
  ksefNumber: v.nullish(v.string()),
});

// Terminal invoice failures KSeF documents for an online session: 405 session
// error, 410 permissions, 415 attachment, 430 file verification, 435
// decryption, 450 semantic verification.
const REJECTED_INVOICE_CODES: ReadonlySet<number> = new Set([
  405, 410, 415, 430, 435, 450,
]);

export class KsefClient {
  readonly #environment: KsefEnvironment;
  readonly #transport: KsefTransport;
  readonly #authenticator: Authenticator;
  readonly #clock: Clock;
  constructor(options: ClientOptions) {
    this.#environment = options.environment;
    this.#transport = options.transport;
    this.#authenticator = options.authenticator;
    this.#clock = options.clock ?? defaultClock;
  }
  async #authorized(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    accept?: RequestOptions["accept"],
  ) {
    const token = await this.#authenticator.getAccessToken();
    if (token.isErr()) {
      return Result.err(token.error);
    }
    return await request({
      transport: this.#transport,
      environment: this.#environment,
      method,
      path,
      token: token.value,
      ...(body === undefined ? {} : { body }),
      ...(accept === undefined ? {} : { accept }),
    });
  }
  async openOnlineSession(): Promise<KsefResult<OnlineSession>> {
    const certificate = await certificateFor(
      this.#transport,
      this.#environment,
      "SymmetricKeyEncryption",
      this.#clock.now(),
    );
    if (certificate.isErr()) {
      return Result.err(certificate.error);
    }
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const keyResult = await Result.tryPromise({
      try: async () =>
        await crypto.subtle.importKey(
          "raw",
          rawKey,
          { name: "AES-CBC" },
          false,
          ["encrypt"],
        ),
      catch: () =>
        invalidResponse(
          "The session encryption key could not be prepared; retry opening the session.",
        ),
    });
    if (keyResult.isErr()) {
      rawKey.fill(0);
      return Result.err(keyResult.error);
    }
    const encryptedKey = await rsaEncrypt(
      certificate.value.certificate,
      rawKey,
    );
    rawKey.fill(0);
    if (encryptedKey.isErr()) {
      return Result.err(encryptedKey.error);
    }
    const response = await this.#authorized("POST", "/sessions/online", {
      formCode: KSEF_FA3_FORM_CODE,
      encryption: {
        encryptedSymmetricKey: base64(encryptedKey.value),
        initializationVector: base64(iv),
        publicKeyId: certificate.value.publicKeyId,
      },
    });
    if (response.isErr()) {
      return Result.err(response.error);
    }
    const opened = parseResponse(
      response.value.body,
      sessionResponseSchema,
      "KSeF session response omitted its reference or validity; do not send an invoice and retry opening the session.",
    );
    if (opened.isErr()) {
      return Result.err(opened.error);
    }
    return Result.ok({
      sessionReferenceNumber: opened.value.referenceNumber,
      validUntil: opened.value.validUntil,
      key: keyResult.value,
      iv,
    });
  }
  async sendInvoice(
    session: OnlineSession,
    xml: string | Uint8Array,
  ): Promise<KsefResult<SentInvoice>> {
    const plaintext = typeof xml === "string" ? encoder.encode(xml) : xml;
    if (plaintext.byteLength > MAX_INVOICE_BYTES) {
      return Result.err(
        error(
          "invalid_input",
          "The FA(3) XML exceeds KSeF's 1 MB online-session limit; reduce the invoice before sending it.",
          false,
        ),
      );
    }
    const encrypted = await Result.tryPromise({
      try: async () =>
        new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-CBC", iv: Buffer.from(session.iv) },
            session.key,
            Buffer.from(plaintext),
          ),
        ),
      catch: () =>
        invalidResponse(
          "The invoice could not be encrypted; open a new session before retrying.",
        ),
    });
    if (encrypted.isErr()) {
      return Result.err(encrypted.error);
    }
    const response = await this.#authorized(
      "POST",
      `/sessions/online/${encodeURIComponent(session.sessionReferenceNumber)}/invoices`,
      {
        invoiceHash: sha256Base64(plaintext),
        invoiceSize: plaintext.byteLength,
        encryptedInvoiceHash: sha256Base64(encrypted.value),
        encryptedInvoiceSize: encrypted.value.byteLength,
        encryptedInvoiceContent: base64(encrypted.value),
      },
    );
    if (response.isErr()) {
      return Result.err(response.error);
    }
    const sent = parseResponse(
      response.value.body,
      invoiceResponseSchema,
      "KSeF accepted the send request without an invoice reference; preserve the session reference and query KSeF before resending.",
    );
    if (sent.isErr()) {
      return Result.err(sent.error);
    }
    return Result.ok({
      sessionReferenceNumber: session.sessionReferenceNumber,
      invoiceReferenceNumber: sent.value.referenceNumber,
    });
  }
  async getInvoiceStatus(
    references: SentInvoice,
  ): Promise<KsefResult<KsefInvoiceStatus>> {
    const response = await this.#authorized(
      "GET",
      `/sessions/${encodeURIComponent(references.sessionReferenceNumber)}/invoices/${encodeURIComponent(references.invoiceReferenceNumber)}`,
    );
    if (response.isErr()) {
      return Result.err(response.error);
    }
    const body = parseResponse(
      response.value.body,
      invoiceStatusSchema,
      "KSeF returned an invalid invoice status; preserve both references and retry later.",
    );
    if (body.isErr()) {
      return Result.err(body.error);
    }
    const { code } = body.value.status;
    const description =
      body.value.status.description ?? "No description supplied by KSeF";
    const { ksefNumber } = body.value;
    const originalKsefNumber = body.value.status.extensions?.originalKsefNumber;
    if (code === 100 || code === 150) {
      return Result.ok({ status: "processing", code, description });
    }
    if (code === 200 && ksefNumber) {
      return Result.ok({ status: "accepted", code, description, ksefNumber });
    }
    if (code === 440 && originalKsefNumber) {
      return Result.ok({
        status: "duplicate",
        code,
        description,
        ksefNumber: originalKsefNumber,
      });
    }
    if (REJECTED_INVOICE_CODES.has(code)) {
      return Result.ok({ status: "rejected", code, description });
    }
    return Result.err(
      error(
        "unknown_status",
        `KSeF returned unknown invoice status ${code}; preserve both references and update the client before deciding the invoice outcome.`,
        false,
        { statusCode: code },
      ),
    );
  }
  async closeOnlineSession(
    sessionReferenceNumber: string,
  ): Promise<KsefResult<{ sessionReferenceNumber: string }>> {
    const response = await this.#authorized(
      "POST",
      `/sessions/online/${encodeURIComponent(sessionReferenceNumber)}/close`,
      {},
    );
    if (response.isErr()) {
      return Result.err(response.error);
    }
    return Result.ok({ sessionReferenceNumber });
  }
  async getInvoiceUpo(
    references: SentInvoice,
  ): Promise<KsefResult<Uint8Array>> {
    const response = await this.#authorized(
      "GET",
      `/sessions/${encodeURIComponent(references.sessionReferenceNumber)}/invoices/${encodeURIComponent(references.invoiceReferenceNumber)}/upo`,
      undefined,
      "application/xml",
    );
    if (response.isErr()) {
      return Result.err(response.error);
    }
    return Result.ok(response.value.body);
  }
}

export const createKsefInvoiceVerificationUrl = (
  environment: KsefEnvironment,
  nip: string,
  issueDate: string,
  xml: string | Uint8Array,
): KsefResult<string> => {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(issueDate);
  if (dateMatch === null || !/^\d{10}$/u.test(nip)) {
    return Result.err(
      error(
        "invalid_input",
        "KSeF QR data needs a 10-digit NIP and issue date in YYYY-MM-DD format; correct them and try again.",
        false,
      ),
    );
  }
  const year = dateMatch.at(1);
  const month = dateMatch.at(2);
  const day = dateMatch.at(3);
  if (year === undefined || month === undefined || day === undefined) {
    return Result.err(
      error(
        "invalid_input",
        "KSeF QR issue date is incomplete; correct it and try again.",
        false,
      ),
    );
  }
  const bytes = typeof xml === "string" ? encoder.encode(xml) : xml;
  return Result.ok(
    `${QR_URLS[environment]}/invoice/${nip}/${day}-${month}-${year}/${sha256Base64Url(bytes)}`,
  );
};
