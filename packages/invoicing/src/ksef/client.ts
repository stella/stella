/* oxlint-disable result-boundary/no-throw-outside-boundary, result-boundary/no-try-catch-outside-boundary -- This injected HTTP protocol adapter is itself the external boundary and rejects with only KsefError. */
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/no-unsafe-assignment -- Remote JSON is retained as unknown and each consumed field is checked before use. */
import { TaggedError } from "better-result";
/**
 * KSeF 2.0 online-session protocol client.
 *
 * Persist the returned session and invoice references before continuing. Never
 * resend after an unknown outcome: KSeF deduplicates by seller NIP, invoice
 * type, and invoice number, and reports the original invoice as status 440.
 */
import { X509Certificate } from "node:crypto";

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
  getAccessToken: () => Promise<string>;
};

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");
const jsonBytes = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const safeJson = (bytes: Uint8Array): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (isRecord(value)) {
      return value;
    }
  } catch {
    // Converted below to a typed boundary error without reflecting response data.
  }
  throw new KsefError({
    kind: "invalid_response",
    message:
      "KSeF returned an unreadable response; retry the operation or contact KSeF support.",
    retryable: false,
  });
};

const responseDescription = (body: Uint8Array): string | undefined => {
  try {
    const value: unknown = JSON.parse(decoder.decode(body));
    if (!isRecord(value)) {
      return undefined;
    }
    const record = value;
    if (typeof record["detail"] === "string") {
      return record["detail"];
    }
    if (typeof record["description"] === "string") {
      return record["description"];
    }
    const exception = Array.isArray(record["exception"])
      ? record["exception"].at(0)
      : undefined;
    if (isRecord(exception)) {
      const description = exception["exceptionDescription"];
      return typeof description === "string" ? description : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

type RequestOptions = {
  transport: KsefTransport;
  environment: KsefEnvironment;
  method: "GET" | "POST";
  path: string;
  token?: string;
  body?: unknown;
};

const request = async ({
  transport,
  environment,
  method,
  path,
  token,
  body,
}: RequestOptions) => {
  let response: Awaited<ReturnType<KsefTransport>>;
  try {
    response = await transport({
      method,
      url: `${API_URLS[environment]}${path}`,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Error-Format": "problem-details",
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: jsonBytes(body) }),
    });
  } catch {
    throw new KsefError({
      kind: "unavailable",
      message:
        "KSeF could not be reached; retry the operation without resending an invoice whose outcome is unknown.",
      retryable: true,
    });
  }
  if (response.status >= 200 && response.status < 300) {
    return response;
  }
  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get("Retry-After"));
    throw new KsefError({
      kind: "rate_limited",
      message: "KSeF rate limit was reached; retry after the indicated delay.",
      retryable: true,
      ...(Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}),
      statusCode: 429,
    });
  }
  if (response.status >= 500) {
    throw new KsefError({
      kind: "unavailable",
      message:
        "KSeF is temporarily unavailable; retry the operation without resending an invoice whose outcome is unknown.",
      retryable: true,
      statusCode: response.status,
    });
  }
  if (response.status === 401 || response.status === 403) {
    const description = responseDescription(response.body);
    const permission = description?.includes("InvoiceWrite")
      ? " The InvoiceWrite permission is required."
      : "";
    throw new KsefError({
      kind: "unauthorized",
      message: `KSeF refused authorization.${permission} Re-authenticate or ask an administrator to grant the required permission.`,
      retryable: false,
      statusCode: response.status,
    });
  }
  throw new KsefError({
    kind: "invalid_response",
    message: `KSeF rejected the request with HTTP ${response.status}; correct the request using the KSeF response and try again.`,
    retryable: false,
    statusCode: response.status,
  });
};

type CertificateUsage = "KsefTokenEncryption" | "SymmetricKeyEncryption";
type MfCertificate = {
  certificate: string;
  publicKeyId: string;
  validFrom: string;
  validTo: string;
  usage: unknown;
};

const certificateFor = async (
  transport: KsefTransport,
  environment: KsefEnvironment,
  usage: CertificateUsage,
  now: Date,
) => {
  const response = await request({
    transport,
    environment,
    method: "GET",
    path: "/security/public-key-certificates",
  });
  const parsed: unknown = JSON.parse(decoder.decode(response.body));
  const certificates = Array.isArray(parsed) ? parsed : [];
  const match = certificates.find((candidate): candidate is MfCertificate => {
    if (!isRecord(candidate)) {
      return false;
    }
    const item = candidate;
    return (
      typeof item["certificate"] === "string" &&
      typeof item["publicKeyId"] === "string" &&
      typeof item["validFrom"] === "string" &&
      typeof item["validTo"] === "string" &&
      Array.isArray(item["usage"]) &&
      item["usage"].includes(usage) &&
      new Date(item["validFrom"]) <= now &&
      now <= new Date(item["validTo"])
    );
  });
  if (match === undefined) {
    throw new KsefError({
      kind: "no_valid_certificate",
      message: `KSeF has no currently valid ${usage} certificate; refresh certificates later or contact KSeF support.`,
      retryable: false,
    });
  }
  return match;
};

const importRsaPublicKey = async (
  certificate: string,
  hash: "SHA-256" | "SHA-1",
) => {
  try {
    const x509 = new X509Certificate(Buffer.from(certificate, "base64"));
    const spki = x509.publicKey.export({ type: "spki", format: "der" });
    return await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSA-OAEP", hash },
      false,
      ["encrypt"],
    );
  } catch {
    throw new KsefError({
      kind: "invalid_response",
      message:
        "KSeF supplied an invalid encryption certificate; refresh certificates or contact KSeF support.",
      retryable: false,
    });
  }
};

const rsaEncrypt = async (certificate: string, plaintext: Uint8Array) => {
  const key = await importRsaPublicKey(certificate, "SHA-256");
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      key,
      Buffer.from(plaintext),
    ),
  );
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

  const login = async () => {
    const challengeResponse = await request({
      transport: options.transport,
      environment: options.environment,
      method: "POST",
      path: "/auth/challenge",
      body: {},
    });
    const challenge = safeJson(challengeResponse.body);
    if (
      typeof challenge["challenge"] !== "string" ||
      typeof challenge["timestamp"] !== "string"
    ) {
      throw new KsefError({
        kind: "invalid_response",
        message:
          "KSeF challenge omitted required fields; retry authentication.",
        retryable: false,
      });
    }
    const certificate = await certificateFor(
      options.transport,
      options.environment,
      "KsefTokenEncryption",
      clock.now(),
    );
    const timestamp = new Date(challenge["timestamp"]).getTime();
    const encryptedToken = await rsaEncrypt(
      certificate.certificate,
      encoder.encode(`${options.ksefToken}|${timestamp}`),
    );
    const initResponse = await request({
      transport: options.transport,
      environment: options.environment,
      method: "POST",
      path: "/auth/ksef-token",
      body: {
        challenge: challenge["challenge"],
        contextIdentifier: { type: "Nip", value: options.nip },
        encryptedToken: base64(encryptedToken),
        publicKeyId: certificate.publicKeyId,
      },
    });
    const init = safeJson(initResponse.body);
    const temporary = init["authenticationToken"] as Partial<Token> | undefined;
    if (
      typeof init["referenceNumber"] !== "string" ||
      typeof temporary?.token !== "string"
    ) {
      throw new KsefError({
        kind: "invalid_response",
        message:
          "KSeF authentication start omitted required fields; retry authentication.",
        retryable: false,
      });
    }
    let authenticated = false;
    for (let attempt = 0; attempt < polling.maxAttempts; attempt += 1) {
      const statusResponse = await request({
        transport: options.transport,
        environment: options.environment,
        method: "GET",
        path: `/auth/${encodeURIComponent(init["referenceNumber"])}`,
        token: temporary.token,
      });
      const statusBody = safeJson(statusResponse.body);
      const status = statusBody["status"] as
        Record<string, unknown> | undefined;
      if (status?.["code"] === 200) {
        authenticated = true;
        break;
      }
      if (status?.["code"] !== 100) {
        throw new KsefError({
          kind: "authentication_failed",
          message: `KSeF authentication failed with status ${String(status?.["code"])}; verify the KSeF token, NIP, and permissions.`,
          retryable: false,
          ...(typeof status?.["code"] === "number"
            ? { statusCode: status["code"] }
            : {}),
        });
      }
      await clock.sleep(polling.delayMilliseconds * (attempt + 1));
    }
    if (!authenticated) {
      throw new KsefError({
        kind: "authentication_failed",
        message:
          "KSeF authentication did not finish in time; retry status polling before starting a new login.",
        retryable: true,
      });
    }
    const redeemResponse = await request({
      transport: options.transport,
      environment: options.environment,
      method: "POST",
      path: "/auth/token/redeem",
      token: temporary.token,
      body: {},
    });
    const redeemed = safeJson(redeemResponse.body);
    const accessToken = redeemed["accessToken"] as Token | undefined;
    const refreshToken = redeemed["refreshToken"] as Token | undefined;
    if (
      typeof accessToken?.token !== "string" ||
      typeof accessToken.validUntil !== "string" ||
      typeof refreshToken?.token !== "string" ||
      typeof refreshToken.validUntil !== "string"
    ) {
      throw new KsefError({
        kind: "invalid_response",
        message:
          "KSeF token redemption omitted token validity data; retry authentication.",
        retryable: false,
      });
    }
    tokens = { accessToken, refreshToken };
  };

  return {
    getAccessToken: async () => {
      if (tokens === undefined) {
        await login();
      }
      if (tokens === undefined) {
        throw new KsefError({
          kind: "authentication_failed",
          message:
            "KSeF authentication did not produce tokens; retry authentication.",
          retryable: false,
        });
      }
      if (
        new Date(tokens.accessToken.validUntil).getTime() -
          clock.now().getTime() <=
        refreshMargin
      ) {
        const refreshedResponse = await request({
          transport: options.transport,
          environment: options.environment,
          method: "POST",
          path: "/auth/token/refresh",
          token: tokens.refreshToken.token,
          body: {},
        });
        const refreshed = safeJson(refreshedResponse.body);
        const accessToken = refreshed["accessToken"] as Token | undefined;
        if (
          typeof accessToken?.token !== "string" ||
          typeof accessToken.validUntil !== "string"
        ) {
          throw new KsefError({
            kind: "invalid_response",
            message:
              "KSeF token refresh omitted validity data; authenticate again.",
            retryable: false,
          });
        }
        tokens = { accessToken, refreshToken: tokens.refreshToken };
      }
      return tokens.accessToken.token;
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
export type InvoiceStatus =
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

  async #authorized(method: "GET" | "POST", path: string, body?: unknown) {
    return request({
      transport: this.#transport,
      environment: this.#environment,
      method,
      path,
      token: await this.#authenticator.getAccessToken(),
      ...(body === undefined ? {} : { body }),
    });
  }

  async openOnlineSession(): Promise<OnlineSession> {
    const certificate = await certificateFor(
      this.#transport,
      this.#environment,
      "SymmetricKeyEncryption",
      this.#clock.now(),
    );
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-CBC" },
      false,
      ["encrypt"],
    );
    const encryptedSymmetricKey = await rsaEncrypt(
      certificate.certificate,
      rawKey,
    );
    rawKey.fill(0);
    const response = await this.#authorized("POST", "/sessions/online", {
      formCode: KSEF_FA3_FORM_CODE,
      encryption: {
        encryptedSymmetricKey: base64(encryptedSymmetricKey),
        initializationVector: base64(iv),
      },
    });
    const opened = safeJson(response.body);
    if (
      typeof opened["referenceNumber"] !== "string" ||
      typeof opened["validUntil"] !== "string"
    ) {
      throw new KsefError({
        kind: "invalid_response",
        message:
          "KSeF session response omitted its reference or validity; do not send an invoice and retry opening the session.",
        retryable: false,
      });
    }
    return {
      sessionReferenceNumber: opened["referenceNumber"],
      validUntil: opened["validUntil"],
      key,
      iv,
    };
  }

  async sendInvoice(
    session: OnlineSession,
    xml: string | Uint8Array,
  ): Promise<SentInvoice> {
    const plaintext = typeof xml === "string" ? encoder.encode(xml) : xml;
    if (plaintext.byteLength > MAX_INVOICE_BYTES) {
      throw new KsefError({
        kind: "invalid_input",
        message:
          "The FA(3) XML exceeds KSeF's 1 MB online-session limit; reduce the invoice before sending it.",
        retryable: false,
      });
    }
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-CBC", iv: Buffer.from(session.iv) },
        session.key,
        Buffer.from(plaintext),
      ),
    );
    const hash = (value: Uint8Array) => sha256Base64(value);
    const response = await this.#authorized(
      "POST",
      `/sessions/online/${encodeURIComponent(session.sessionReferenceNumber)}/invoices`,
      {
        invoiceHash: hash(plaintext),
        invoiceSize: plaintext.byteLength,
        encryptedInvoiceHash: hash(encrypted),
        encryptedInvoiceSize: encrypted.byteLength,
        encryptedInvoiceContent: base64(encrypted),
      },
    );
    const sent = safeJson(response.body);
    if (typeof sent["referenceNumber"] !== "string") {
      throw new KsefError({
        kind: "invalid_response",
        message:
          "KSeF accepted the send request without an invoice reference; preserve the session reference and query KSeF before resending.",
        retryable: false,
      });
    }
    return {
      sessionReferenceNumber: session.sessionReferenceNumber,
      invoiceReferenceNumber: sent["referenceNumber"],
    };
  }

  async getInvoiceStatus(references: SentInvoice): Promise<InvoiceStatus> {
    const response = await this.#authorized(
      "GET",
      `/sessions/${encodeURIComponent(references.sessionReferenceNumber)}/invoices/${encodeURIComponent(references.invoiceReferenceNumber)}`,
    );
    const body = safeJson(response.body);
    const status = body["status"] as Record<string, unknown> | undefined;
    const code = status?.["code"];
    const description =
      typeof status?.["description"] === "string"
        ? status["description"]
        : "No description supplied by KSeF";
    let ksefNumber: string | undefined;
    if (typeof body["ksefNumber"] === "string") {
      ksefNumber = body["ksefNumber"];
    } else if (typeof status?.["ksefNumber"] === "string") {
      ksefNumber = status["ksefNumber"];
    }
    if (code === 100 || code === 150) {
      return { status: "processing", code, description };
    }
    if (code === 200 && ksefNumber !== undefined) {
      return { status: "accepted", code, description, ksefNumber };
    }
    if (code === 440 && ksefNumber !== undefined) {
      return { status: "duplicate", code, description, ksefNumber };
    }
    if (code === 430 || code === 450) {
      return { status: "rejected", code, description };
    }
    throw new KsefError({
      kind: "unknown_status",
      message: `KSeF returned unknown invoice status ${String(code)}; preserve both references and update the client before deciding the invoice outcome.`,
      retryable: false,
      ...(typeof code === "number" ? { statusCode: code } : {}),
    });
  }

  async closeOnlineSession(
    sessionReferenceNumber: string,
  ): Promise<{ sessionReferenceNumber: string }> {
    await this.#authorized(
      "POST",
      `/sessions/online/${encodeURIComponent(sessionReferenceNumber)}/close`,
      {},
    );
    return { sessionReferenceNumber };
  }

  async getInvoiceUpo(references: SentInvoice): Promise<Uint8Array> {
    const response = await this.#authorized(
      "GET",
      `/sessions/${encodeURIComponent(references.sessionReferenceNumber)}/invoices/${encodeURIComponent(references.invoiceReferenceNumber)}/upo`,
    );
    return response.body;
  }
}

export const createKsefInvoiceVerificationUrl = (
  environment: KsefEnvironment,
  nip: string,
  issueDate: string,
  xml: string | Uint8Array,
): string => {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(issueDate);
  if (dateMatch === null || !/^\d{10}$/u.test(nip)) {
    throw new KsefError({
      kind: "invalid_input",
      message:
        "KSeF QR data needs a 10-digit NIP and issue date in YYYY-MM-DD format; correct them and try again.",
      retryable: false,
    });
  }
  const year = dateMatch.at(1);
  const month = dateMatch.at(2);
  const day = dateMatch.at(3);
  if (year === undefined || month === undefined || day === undefined) {
    throw new KsefError({
      kind: "invalid_input",
      message: "KSeF QR issue date is incomplete; correct it and try again.",
      retryable: false,
    });
  }
  const bytes = typeof xml === "string" ? encoder.encode(xml) : xml;
  const hash = sha256Base64Url(bytes);
  return `${QR_URLS[environment]}/invoice/${nip}/${day}-${month}-${year}/${hash}`;
};
