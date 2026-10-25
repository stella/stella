import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Base64 } from "@stll/sha256/bun";

import {
  createKsefInvoiceVerificationUrl,
  createKsefTokenAuthenticator,
  KsefClient,
  KsefError,
  type KsefTransport,
} from "./client";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const directory = mkdtempSync(path.join(tmpdir(), "stella-ksef-"));
const keyPath = path.join(directory, "key.pem");
const certificatePath = path.join(directory, "certificate.der");
const generated = Bun.spawnSync([
  "openssl",
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-keyout",
  keyPath,
  "-out",
  certificatePath,
  "-outform",
  "DER",
  "-nodes",
  "-days",
  "2",
  "-subj",
  "/CN=KSeF test",
]);
if (generated.exitCode !== 0) {
  throw new Error(decoder.decode(generated.stderr));
}

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const certificate = readFileSync(certificatePath).toString("base64");
const privateKey = await crypto.subtle.importKey(
  "pkcs8",
  Buffer.from(
    readFileSync(keyPath, "utf-8")
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replaceAll(/\s/gu, ""),
    "base64",
  ),
  { name: "RSA-OAEP", hash: "SHA-256" },
  false,
  ["decrypt"],
);

const response = (
  status: number,
  value?: unknown,
  headers = new Headers(),
) => ({
  status,
  headers,
  body:
    value instanceof Uint8Array
      ? value
      : encoder.encode(value === undefined ? "" : JSON.stringify(value)),
});

const createFake = () => {
  let aesKey: CryptoKey | undefined;
  let iv: Uint8Array | undefined;
  let received = "";
  let refreshes = 0;
  const validFrom = new Date(Date.now() - 60_000).toISOString();
  const validTo = new Date(Date.now() + 86_400_000).toISOString();
  const transport: KsefTransport = async ({ method, url, headers, body }) => {
    const requestPath = new URL(url).pathname.replace("/v2", "");
    const json = body === undefined ? {} : JSON.parse(decoder.decode(body));
    if (requestPath === "/security/public-key-certificates") {
      return response(200, [
        {
          certificate,
          publicKeyId: "token-key",
          validFrom,
          validTo,
          usage: ["KsefTokenEncryption"],
        },
        {
          certificate,
          publicKeyId: "session-key",
          validFrom,
          validTo,
          usage: ["SymmetricKeyEncryption"],
        },
      ]);
    }
    if (requestPath === "/auth/challenge") {
      return response(200, {
        challenge: "challenge",
        timestamp: "2026-04-01T00:00:00.000Z",
      });
    }
    if (requestPath === "/auth/ksef-token") {
      const clear = await crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        privateKey,
        Buffer.from(json.encryptedToken, "base64"),
      );
      expect(decoder.decode(clear)).toBe("secret-token|1775001600000");
      return response(202, {
        referenceNumber: "auth-ref",
        authenticationToken: { token: "temporary", validUntil: validTo },
      });
    }
    if (requestPath === "/auth/auth-ref") {
      return response(200, { status: { code: 200, description: "ok" } });
    }
    if (requestPath === "/auth/token/redeem") {
      return response(200, {
        accessToken: {
          token: "access",
          validUntil: new Date(Date.now() + 10).toISOString(),
        },
        refreshToken: { token: "refresh", validUntil: validTo },
      });
    }
    if (requestPath === "/auth/token/refresh") {
      refreshes += 1;
      return response(200, {
        accessToken: { token: "fresh-access", validUntil: validTo },
      });
    }
    expect(headers["Authorization"]).toBe("Bearer fresh-access");
    if (requestPath === "/sessions/online") {
      expect(json.formCode).toEqual({
        systemCode: "FA (3)",
        schemaVersion: "1-0E",
        value: "FA",
      });
      const rawKey = await crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        privateKey,
        Buffer.from(json.encryption.encryptedSymmetricKey, "base64"),
      );
      aesKey = await crypto.subtle.importKey("raw", rawKey, "AES-CBC", false, [
        "decrypt",
      ]);
      iv = new Uint8Array(
        Buffer.from(json.encryption.initializationVector, "base64"),
      );
      return response(201, {
        referenceNumber: "session-ref",
        validUntil: validTo,
      });
    }
    if (requestPath === "/sessions/online/session-ref/invoices") {
      if (aesKey === undefined || iv === undefined) {
        throw new Error("session encryption not initialized");
      }
      const encrypted = new Uint8Array(
        Buffer.from(json.encryptedInvoiceContent, "base64"),
      );
      const clear = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-CBC", iv: Buffer.from(iv) },
          aesKey,
          encrypted,
        ),
      );
      received = decoder.decode(clear);
      const hash = (bytes: Uint8Array) => sha256Base64(bytes);
      expect(json.invoiceSize).toBe(clear.byteLength);
      expect(json.invoiceHash).toBe(hash(clear));
      expect(json.encryptedInvoiceSize).toBe(encrypted.byteLength);
      expect(json.encryptedInvoiceHash).toBe(hash(encrypted));
      return response(202, { referenceNumber: "invoice-ref" });
    }
    if (
      requestPath === "/sessions/session-ref/invoices/invoice-ref" &&
      method === "GET"
    ) {
      return response(200, {
        status: { code: 200, description: "accepted" },
        ksefNumber: "123-KSEF",
      });
    }
    if (requestPath.endsWith("/upo")) {
      return response(200, encoder.encode("<upo signed='yes'/>"));
    }
    if (requestPath === "/sessions/online/session-ref/close") {
      return response(204);
    }
    return response(404);
  };
  return { transport, received: () => received, refreshes: () => refreshes };
};

describe("KSeF online session", () => {
  test("logs in, refreshes, encrypts and resumes an accepted invoice through UPO", async () => {
    const fake = createFake();
    const authenticator = createKsefTokenAuthenticator({
      environment: "test",
      transport: fake.transport,
      nip: "1111111111",
      ksefToken: "secret-token",
      refreshMarginMilliseconds: 1000,
    });
    const client = new KsefClient({
      environment: "test",
      transport: fake.transport,
      authenticator,
    });
    const session = await client.openOnlineSession();
    const sent = await client.sendInvoice(session, "<Faktura>żąć</Faktura>");
    expect(fake.received()).toBe("<Faktura>żąć</Faktura>");
    expect(fake.refreshes()).toBe(1);
    const resumedClient = new KsefClient({
      environment: "test",
      transport: fake.transport,
      authenticator,
    });
    expect(await resumedClient.getInvoiceStatus(sent)).toEqual({
      status: "accepted",
      code: 200,
      description: "accepted",
      ksefNumber: "123-KSEF",
    });
    await resumedClient.closeOnlineSession(sent.sessionReferenceNumber);
    expect(decoder.decode(await resumedClient.getInvoiceUpo(sent))).toBe(
      "<upo signed='yes'/>",
    );
  });

  test("rejects oversized XML before transport", async () => {
    const fake = createFake();
    const client = new KsefClient({
      environment: "test",
      transport: fake.transport,
      authenticator: { getAccessToken: async () => "access" },
    });
    const failure = await client
      .sendInvoice(
        {
          sessionReferenceNumber: "s",
          validUntil: "",
          key: await crypto.subtle.generateKey(
            { name: "AES-CBC", length: 256 },
            false,
            ["encrypt"],
          ),
          iv: new Uint8Array(16),
        },
        new Uint8Array(1_000_001),
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KsefError);
    if (failure instanceof KsefError) {
      expect(failure.kind).toBe("invalid_input");
    }
  });

  test("maps retryable transport failures without leaking secrets", async () => {
    const secret = "must-not-leak";
    const authenticator = createKsefTokenAuthenticator({
      environment: "test",
      transport: async () => {
        throw new Error(secret);
      },
      nip: "1111111111",
      ksefToken: secret,
    });
    const failure = await authenticator
      .getAccessToken()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KsefError);
    expect(JSON.stringify(failure)).not.toContain(secret);
    if (failure instanceof KsefError) {
      expect(failure.kind).toBe("unavailable");
    }
  });

  test("builds the documented environment-specific KOD I link", async () => {
    const url = createKsefInvoiceVerificationUrl(
      "test",
      "1111111111",
      "2026-02-01",
      "xml",
    );
    expect(url).toBe(
      "https://qr-test.ksef.mf.gov.pl/invoice/1111111111/01-02-2026/v5KgTmC0sjYtRUkOUULke2h8LrtYmNprxxtpdgIBbm4",
    );
  });

  test.each([
    [440, "duplicate", "ORIGINAL-KSEF"],
    [450, "rejected", undefined],
  ] as const)(
    "maps documented invoice status %i",
    async (code, expected, ksefNumber) => {
      const transport: KsefTransport = async () =>
        response(200, {
          status: { code, description: "MF description", ksefNumber },
        });
      const client = new KsefClient({
        environment: "test",
        transport,
        authenticator: { getAccessToken: async () => "access" },
      });
      const status = await client.getInvoiceStatus({
        sessionReferenceNumber: "session",
        invoiceReferenceNumber: "invoice",
      });
      expect(status.status).toBe(expected);
      if (status.status === "duplicate") {
        expect(status.ksefNumber).toBe("ORIGINAL-KSEF");
      }
    },
  );

  test("refuses an unknown invoice status", async () => {
    const client = new KsefClient({
      environment: "test",
      transport: async () => response(200, { status: { code: 299 } }),
      authenticator: { getAccessToken: async () => "access" },
    });
    const failure = await client
      .getInvoiceStatus({
        sessionReferenceNumber: "session",
        invoiceReferenceNumber: "invoice",
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KsefError);
    if (failure instanceof KsefError) {
      expect(failure.kind).toBe("unknown_status");
    }
  });

  test.each([
    [429, "rate_limited", true],
    [503, "unavailable", true],
    [403, "unauthorized", false],
  ] as const)("types HTTP failure %i", async (httpStatus, kind, retryable) => {
    const headers = new Headers({ "Retry-After": "7" });
    const client = new KsefClient({
      environment: "test",
      transport: async () =>
        response(httpStatus, { detail: "InvoiceWrite is required" }, headers),
      authenticator: { getAccessToken: async () => "access" },
    });
    const failure = await client
      .getInvoiceStatus({
        sessionReferenceNumber: "session",
        invoiceReferenceNumber: "invoice",
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KsefError);
    if (failure instanceof KsefError) {
      expect(failure.kind).toBe(kind);
      expect(failure.retryable).toBe(retryable);
      if (httpStatus === 429) {
        expect(failure.retryAfterSeconds).toBe(7);
      }
    }
  });

  test("refuses to open without a valid MF certificate", async () => {
    const client = new KsefClient({
      environment: "test",
      transport: async () => response(200, []),
      authenticator: { getAccessToken: async () => "access" },
    });
    const failure = await client
      .openOnlineSession()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KsefError);
    if (failure instanceof KsefError) {
      expect(failure.kind).toBe("no_valid_certificate");
    }
  });
});
