import { Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Base64 } from "@stll/sha256/bun";

import {
  createKsefCertificateAuthenticator,
  createKsefInvoiceVerificationUrl,
  createKsefTokenAuthenticator,
  KsefClient,
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

const createSigningFixture = async (
  kind: "ec" | "rsa",
  rsaHash: "SHA-256" | "SHA-384" = "SHA-256",
) => {
  const fixtureDirectory = mkdtempSync(path.join(directory, `${kind}-`));
  const signingKeyPath = path.join(fixtureDirectory, "key.pem");
  const signingCertificatePath = path.join(fixtureDirectory, "certificate.der");
  const command =
    kind === "ec"
      ? [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
        ]
      : ["openssl", "req", "-x509", "-newkey", "rsa:2048"];
  const result = Bun.spawnSync([
    ...command,
    "-keyout",
    signingKeyPath,
    "-out",
    signingCertificatePath,
    "-outform",
    "DER",
    "-nodes",
    "-days",
    "2",
    "-subj",
    `/CN=KSeF ${kind} test`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(decoder.decode(result.stderr));
  }
  const der = readFileSync(signingCertificatePath);
  const pem = readFileSync(signingKeyPath, "utf-8").replaceAll(
    /-----[^-]+-----|\s/gu,
    "",
  );
  const algorithm =
    kind === "ec"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", hash: rsaHash };
  return {
    certificate: new Uint8Array(der),
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(pem, "base64"),
      algorithm,
      false,
      ["sign"],
    ),
  };
};

const signingFixtures = {
  ec: await createSigningFixture("ec"),
  rsa: await createSigningFixture("rsa"),
};

const response = (status: number, value?: unknown, headers = new Headers()) =>
  Result.ok({
    status,
    headers,
    body:
      value instanceof Uint8Array
        ? value
        : encoder.encode(value === undefined ? "" : JSON.stringify(value)),
  });

// Identifiers in the documented shape: Base64 of a SHA-256, 44 characters.
const TOKEN_KEY_ID = "QIoAK/Yc3s27Z4t3SZY4Mhp8JNLH7Vl4N3lNlJAEig8=";
const SESSION_KEY_ID = "35k6IVMTxUPZKQdg4Fbx36T5/v3aoJK5hIY7sS7mt3U=";

const createFake = () => {
  let aesKey: CryptoKey | undefined;
  let iv: Uint8Array | undefined;
  let received = "";
  let refreshes = 0;
  const validFrom = new Date(Date.now() - 60_000).toISOString();
  const validTo = new Date(Date.now() + 86_400_000).toISOString();
  const transport: KsefTransport = async ({ method, url, headers, body }) => {
    const requestPath = new URL(url).pathname.replace("/v2", "");
    if (requestPath === "/auth/xades-signature") {
      expect(headers["Content-Type"]).toBe("application/xml");
      return response(202, {
        referenceNumber: "auth-ref",
        authenticationToken: { token: "temporary", validUntil: validTo },
      });
    }
    const json = body === undefined ? {} : JSON.parse(decoder.decode(body));
    if (requestPath === "/security/public-key-certificates") {
      return response(200, [
        {
          certificate,
          certificateId: TOKEN_KEY_ID,
          publicKeyId: TOKEN_KEY_ID,
          validFrom,
          validTo,
          usage: ["KsefTokenEncryption"],
        },
        {
          certificate,
          certificateId: SESSION_KEY_ID,
          publicKeyId: SESSION_KEY_ID,
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
        timestampMs: 1_775_001_600_000,
      });
    }
    if (requestPath === "/auth/ksef-token") {
      const clear = await crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        privateKey,
        Buffer.from(json.encryptedToken, "base64"),
      );
      expect(decoder.decode(clear)).toBe("secret-token|1775001600000");
      expect(json.publicKeyId).toBe(TOKEN_KEY_ID);
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
      expect(json.encryption.publicKeyId).toBe(SESSION_KEY_ID);
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
      expect(headers["Accept"]).toBe("application/xml");
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
  test.each(["ec", "rsa"] as const)(
    "produces a verifiable %s XAdES-BES authentication document",
    async (kind) => {
      const fixture = signingFixtures[kind];
      let xml = "";
      const fake = createFake();
      const transport: KsefTransport = async (request) => {
        if (new URL(request.url).pathname.endsWith("/auth/xades-signature")) {
          xml = decoder.decode(request.body);
        }
        return await fake.transport(request);
      };
      const authenticator = createKsefCertificateAuthenticator({
        environment: "test",
        transport,
        nip: "1111111111",
        ...fixture,
        clock: {
          now: () => new Date("2026-04-01T00:00:00.000Z"),
          sleep: async () => {},
        },
      });
      expect((await authenticator.getAccessToken()).isOk()).toBe(true);

      const value = (name: string) => {
        const match = new RegExp(
          `<[^>]*${name}[^>]*>([^<]+)</[^>]*${name}>`,
          "u",
        ).exec(xml);
        if (match?.[1] === undefined) {
          throw new Error(`Missing ${name}`);
        }
        return match[1];
      };
      const unsigned = xml.replace(
        /<ds:Signature xmlns:ds=[\s\S]*<\/ds:Signature>/u,
        "",
      );
      const signedProperties =
        /<xades:SignedProperties[\s\S]*?<\/xades:SignedProperties>/u.exec(
          xml,
        )?.[0];
      const signedInfo = /<ds:SignedInfo[\s\S]*?<\/ds:SignedInfo>/u.exec(
        xml,
      )?.[0];
      if (signedProperties === undefined || signedInfo === undefined) {
        throw new Error("Missing signed XAdES fragments");
      }
      const digestValues = [
        ...xml.matchAll(/<ds:DigestValue[^>]*>([^<]+)<\/ds:DigestValue>/gu),
      ].map((match) => match[1]);
      expect(digestValues.at(0)).toBe(sha256Base64(encoder.encode(unsigned)));
      expect(digestValues.at(1)).toBe(
        sha256Base64(encoder.encode(signedProperties)),
      );
      expect(digestValues.at(2)).toBe(sha256Base64(fixture.certificate));

      const parsedCertificate = new X509Certificate(fixture.certificate);
      expect(value("X509IssuerName")).toBe(
        parsedCertificate.issuer.replaceAll("\n", ","),
      );
      expect(value("X509SerialNumber")).toBe(
        BigInt(`0x${parsedCertificate.serialNumber}`).toString(10),
      );
      const publicKey = await crypto.subtle.importKey(
        "spki",
        parsedCertificate.publicKey.export({ type: "spki", format: "der" }),
        kind === "ec"
          ? { name: "ECDSA", namedCurve: "P-256" }
          : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const signature = Buffer.from(value("SignatureValue"), "base64");
      if (kind === "ec") {
        expect(signature.byteLength).toBe(64);
      }
      expect(
        await crypto.subtle.verify(
          kind === "ec"
            ? { name: "ECDSA", hash: "SHA-256" }
            : { name: "RSASSA-PKCS1-v1_5" },
          publicKey,
          signature,
          encoder.encode(signedInfo),
        ),
      ).toBe(true);
    },
  );

  test("escapes a special-character challenge while preserving a valid signature", async () => {
    const fixture = signingFixtures.ec;
    let xml = "";
    const fake = createFake();
    const transport: KsefTransport = async (request) => {
      const requestPath = new URL(request.url).pathname;
      if (requestPath.endsWith("/auth/challenge")) {
        return response(200, {
          challenge: "<&>\r",
          timestamp: "2026-04-01T00:00:00.000Z",
          timestampMs: 1_775_001_600_000,
        });
      }
      if (requestPath.endsWith("/auth/xades-signature")) {
        xml = decoder.decode(request.body);
      }
      return await fake.transport(request);
    };
    const authenticator = createKsefCertificateAuthenticator({
      environment: "test",
      transport,
      nip: "1111111111",
      ...fixture,
    });
    expect((await authenticator.getAccessToken()).isOk()).toBe(true);
    expect(xml).toContain("<Challenge>&lt;&amp;&gt;&#xD;</Challenge>");
  });

  test("uses certificate authentication through an encrypted online send", async () => {
    const fake = createFake();
    const authenticator = createKsefCertificateAuthenticator({
      environment: "test",
      transport: fake.transport,
      nip: "1111111111",
      ...signingFixtures.rsa,
      refreshMarginMilliseconds: 1000,
    });
    const client = new KsefClient({
      environment: "test",
      transport: fake.transport,
      authenticator,
    });
    const session = (await client.openOnlineSession()).unwrap();
    await client.sendInvoice(session, "<Faktura>certyfikat</Faktura>");
    expect(fake.received()).toBe("<Faktura>certyfikat</Faktura>");
  });

  test("rejects an RSA key bound to a hash other than SHA-256 before transport", async () => {
    let calls = 0;
    const authenticator = createKsefCertificateAuthenticator({
      environment: "test",
      transport: async () => {
        calls += 1;
        return response(500);
      },
      nip: "1111111111",
      ...(await createSigningFixture("rsa", "SHA-384")),
    });
    const result = await authenticator.getAccessToken();
    expect(result.isErr() && result.error.kind).toBe("invalid_input");
    expect(calls).toBe(0);
  });

  test("rejects an invalid certificate NIP before transport", async () => {
    let calls = 0;
    const authenticator = createKsefCertificateAuthenticator({
      environment: "test",
      transport: async () => {
        calls += 1;
        return response(500);
      },
      nip: "123",
      ...signingFixtures.ec,
    });
    const result = await authenticator.getAccessToken();
    expect(result.isErr() && result.error.kind).toBe("invalid_input");
    expect(calls).toBe(0);
  });

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
    const session = (await client.openOnlineSession()).unwrap();
    const sent = (
      await client.sendInvoice(session, "<Faktura>żąć</Faktura>")
    ).unwrap();
    expect(fake.received()).toBe("<Faktura>żąć</Faktura>");
    expect(fake.refreshes()).toBe(1);
    const resumedClient = new KsefClient({
      environment: "test",
      transport: fake.transport,
      authenticator,
    });
    expect((await resumedClient.getInvoiceStatus(sent)).unwrap()).toEqual({
      status: "accepted",
      code: 200,
      description: "accepted",
      ksefNumber: "123-KSEF",
    });
    expect(
      (
        await resumedClient.closeOnlineSession(sent.sessionReferenceNumber)
      ).isOk(),
    ).toBe(true);
    expect(
      decoder.decode((await resumedClient.getInvoiceUpo(sent)).unwrap()),
    ).toBe("<upo signed='yes'/>");
  });

  test("logs in again once the refresh token expires or is revoked", async () => {
    // Within the fake certificates' validity window.
    let now = Date.now();
    const at = (offsetMilliseconds: number) =>
      new Date(now + offsetMilliseconds).toISOString();
    let logins = 0;
    let refreshStatus = 200;
    const fake = createFake();
    const transport: KsefTransport = async (request) => {
      const requestPath = new URL(request.url).pathname.replace("/v2", "");
      if (requestPath === "/auth/token/redeem") {
        logins += 1;
        return response(200, {
          accessToken: { token: `access-${logins}`, validUntil: at(600_000) },
          refreshToken: {
            token: `refresh-${logins}`,
            validUntil: at(1_200_000),
          },
        });
      }
      if (requestPath === "/auth/token/refresh") {
        return refreshStatus === 200
          ? response(200, {
              accessToken: { token: "refreshed", validUntil: at(600_000) },
            })
          : response(refreshStatus, { detail: "refresh token revoked" });
      }
      return await fake.transport(request);
    };
    const authenticator = createKsefTokenAuthenticator({
      environment: "test",
      transport,
      nip: "1111111111",
      ksefToken: "secret-token",
      refreshMarginMilliseconds: 1000,
      clock: { now: () => new Date(now), sleep: async () => {} },
    });

    expect((await authenticator.getAccessToken()).unwrap()).toBe("access-1");
    now += 1_800_000;
    expect((await authenticator.getAccessToken()).unwrap()).toBe("access-2");
    now += 700_000;
    refreshStatus = 401;
    expect((await authenticator.getAccessToken()).unwrap()).toBe("access-3");
    now += 700_000;
    refreshStatus = 503;
    const unavailable = await authenticator.getAccessToken();
    expect(unavailable.isErr() && unavailable.error.kind).toBe("unavailable");
    refreshStatus = 200;
    expect((await authenticator.getAccessToken()).unwrap()).toBe("refreshed");
    expect(logins).toBe(3);
  });

  test("rejects oversized XML before transport", async () => {
    const fake = createFake();
    const client = new KsefClient({
      environment: "test",
      transport: fake.transport,
      authenticator: { getAccessToken: async () => Result.ok("access") },
    });
    const failure = await client.sendInvoice(
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
    );
    expect(failure.isErr()).toBe(true);
    if (failure.isErr()) {
      expect(failure.error.kind).toBe("invalid_input");
    }
  });

  test("maps retryable transport failures without leaking secrets", async () => {
    const secret = "must-not-leak";
    const authenticator = createKsefTokenAuthenticator({
      environment: "test",
      transport: async () => Result.err(new Error(secret)),
      nip: "1111111111",
      ksefToken: secret,
    });
    const failure = await authenticator.getAccessToken();
    expect(failure.isErr()).toBe(true);
    expect(JSON.stringify(failure)).not.toContain(secret);
    if (failure.isErr()) {
      expect(failure.error.kind).toBe("unavailable");
    }
  });

  test("builds the documented environment-specific KOD I link", async () => {
    const url = createKsefInvoiceVerificationUrl(
      "test",
      "1111111111",
      "2026-02-01",
      "xml",
    ).unwrap();
    expect(url).toBe(
      "https://qr-test.ksef.mf.gov.pl/invoice/1111111111/01-02-2026/v5KgTmC0sjYtRUkOUULke2h8LrtYmNprxxtpdgIBbm4",
    );
  });

  // Status bodies in the documented SessionInvoiceStatusResponse shape.
  test.each([
    [
      440,
      "duplicate",
      {
        code: 440,
        description: "Duplikat faktury",
        details: ["Duplikat faktury."],
        extensions: {
          originalSessionReferenceNumber:
            "20250626-SO-2F14610000-242991F8C9-B4",
          originalKsefNumber: "ORIGINAL-KSEF",
        },
      },
    ],
    [450, "rejected", { code: 450, description: "MF description" }],
    [405, "rejected", { code: 405, description: "MF description" }],
    [435, "rejected", { code: 435, description: "MF description" }],
  ] as const)(
    "maps documented invoice status %i",
    async (_code, expected, statusInfo) => {
      const transport: KsefTransport = async () =>
        response(200, {
          ordinalNumber: 1,
          referenceNumber: "invoice",
          invoiceHash: "hash",
          invoicingDate: "2026-10-25T10:00:00.000+00:00",
          ksefNumber: null,
          status: statusInfo,
        });
      const client = new KsefClient({
        environment: "test",
        transport,
        authenticator: { getAccessToken: async () => Result.ok("access") },
      });
      const status = (
        await client.getInvoiceStatus({
          sessionReferenceNumber: "session",
          invoiceReferenceNumber: "invoice",
        })
      ).unwrap();
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
      authenticator: { getAccessToken: async () => Result.ok("access") },
    });
    const failure = await client.getInvoiceStatus({
      sessionReferenceNumber: "session",
      invoiceReferenceNumber: "invoice",
    });
    expect(failure.isErr()).toBe(true);
    if (failure.isErr()) {
      expect(failure.error.kind).toBe("unknown_status");
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
      authenticator: { getAccessToken: async () => Result.ok("access") },
    });
    const failure = await client.getInvoiceStatus({
      sessionReferenceNumber: "session",
      invoiceReferenceNumber: "invoice",
    });
    expect(failure.isErr()).toBe(true);
    if (failure.isErr()) {
      expect(failure.error.kind).toBe(kind);
      expect(failure.error.retryable).toBe(retryable);
      if (httpStatus === 429) {
        expect(failure.error.retryAfterSeconds).toBe(7);
      }
    }
  });

  test.each([[null], ["soon"], ["-3"]] as const)(
    "leaves the delay to the caller when Retry-After is %p",
    async (retryAfter) => {
      const headers = new Headers(
        retryAfter === null ? {} : { "Retry-After": retryAfter },
      );
      const client = new KsefClient({
        environment: "test",
        transport: async () => response(429, {}, headers),
        authenticator: { getAccessToken: async () => Result.ok("access") },
      });
      const failure = await client.getInvoiceStatus({
        sessionReferenceNumber: "session",
        invoiceReferenceNumber: "invoice",
      });
      expect(failure.isErr() && failure.error.kind).toBe("rate_limited");
      expect(failure.isErr() && "retryAfterSeconds" in failure.error).toBe(
        false,
      );
    },
  );

  test("refuses to open without a valid MF certificate", async () => {
    const client = new KsefClient({
      environment: "test",
      transport: async () => response(200, []),
      authenticator: { getAccessToken: async () => Result.ok("access") },
    });
    const failure = await client.openOnlineSession();
    expect(failure.isErr()).toBe(true);
    if (failure.isErr()) {
      expect(failure.error.kind).toBe("no_valid_certificate");
    }
  });
});
