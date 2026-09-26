import { describe, expect, test } from "bun:test";

import {
  createFallbackTimestampAuthority,
  createHttpTimestampAuthority,
  PdfSigningTimestampUnavailableError,
} from "@/api/lib/pdf-signing/timestamp-authority";
import {
  isTimestampAuthorityUrlList,
  parseTimestampAuthorityUrls,
} from "@/api/lib/pdf-signing/timestamp-authority-urls";
import {
  PdfSigningTimestampInvalidError,
  validateTimestampToken,
} from "@/api/lib/pdf-signing/timestamp-token";
import {
  createTestTimestampAuthority,
  createTestTimestampCertificate,
  createTestTimestampResponder,
  issueTestTimestampToken,
} from "@/api/tests/helpers/timestamp-token";

const failing = (url: string) => ({
  authority: {
    timestamp: async () => {
      throw new Error(`${url} is down`);
    },
  },
  url,
});

const answering = (url: string, token: Uint8Array) => ({
  authority: { timestamp: async () => token },
  url,
});

describe("configured timestamp authorities", () => {
  test("keeps the list order and appends the single-authority setting", () => {
    expect(
      parseTimestampAuthorityUrls({
        list: "https://a.example/tsa, https://b.example/tsa\nhttp://c.example",
        single: "https://d.example/tsa",
      }),
    ).toEqual([
      "https://a.example/tsa",
      "https://b.example/tsa",
      "http://c.example",
      "https://d.example/tsa",
    ]);
  });

  test("still reads the single-authority setting on its own", () => {
    expect(
      parseTimestampAuthorityUrls({
        list: undefined,
        single: "https://d.example/tsa",
      }),
    ).toEqual(["https://d.example/tsa"]);
    expect(
      parseTimestampAuthorityUrls({ list: undefined, single: undefined }),
    ).toEqual([]);
  });

  test("lists an authority named in both settings once, at its first place", () => {
    expect(
      parseTimestampAuthorityUrls({
        list: "https://a.example/tsa,https://b.example/tsa",
        single: "https://a.example/tsa",
      }),
    ).toEqual(["https://a.example/tsa", "https://b.example/tsa"]);
  });

  test("rejects a list with an entry that is not an http(s) URL", () => {
    expect(isTimestampAuthorityUrlList("https://a.example, ftp://b")).toBe(
      false,
    );
    expect(isTimestampAuthorityUrlList("https://a.example, nonsense")).toBe(
      false,
    );
    expect(isTimestampAuthorityUrlList("https://a.example http://b")).toBe(
      true,
    );
  });
});

describe("falling back across timestamp authorities", () => {
  test("uses the first authority that answers with a valid token and names it", async () => {
    const digest = crypto.getRandomValues(new Uint8Array(32));
    const valid = await createTestTimestampAuthority();
    const authority = createFallbackTimestampAuthority([
      failing("https://a.example/"),
      // Answers, but with a token that is not a timestamp at all.
      answering("https://b.example/", new Uint8Array([1, 2, 3])),
      { authority: valid, url: "https://c.example/" },
      answering("https://d.example/", new Uint8Array([9])),
    ]);

    expect(authority.usedUrl()).toBe(null);
    await authority.timestamp(digest, "SHA-256");
    expect(authority.usedUrl()).toBe("https://c.example/");
    expect(valid.issued()).toBe(1);
  });

  test("refuses a token about another signature and moves on", async () => {
    const digest = crypto.getRandomValues(new Uint8Array(32));
    const wrongImprint = await createTestTimestampAuthority({
      misbehaviour: { imprint: new Uint8Array(32).fill(7) },
    });
    const authority = createFallbackTimestampAuthority([
      { authority: wrongImprint, url: "https://a.example/" },
    ]);

    const failure = await authority
      .timestamp(digest, "SHA-256")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PdfSigningTimestampUnavailableError);
    expect(authority.usedToken()).toBe(null);
  });

  test("reports every failure, in order, when no authority answers", async () => {
    const authority = createFallbackTimestampAuthority([
      failing("https://a.example/"),
      failing("https://b.example/"),
    ]);

    const failure = await authority
      .timestamp(new Uint8Array(32), "SHA-256")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PdfSigningTimestampUnavailableError);
    if (!PdfSigningTimestampUnavailableError.is(failure)) {
      return;
    }
    expect(failure.failures.map(({ url }) => url)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
    expect(authority.usedUrl()).toBe(null);
  });
});

describe("checking a timestamp token", () => {
  const digest = crypto.getRandomValues(new Uint8Array(32));
  const refused = async (token: Uint8Array) =>
    await validateTimestampToken({ digest, now: new Date(), token }).then(
      () => null,
      (error: unknown) => error,
    );

  test("accepts a token about this signature from a timestamping key", async () => {
    const signer = await createTestTimestampCertificate();
    const token = await issueTestTimestampToken({ digest, serial: 1, signer });

    const validated = await validateTimestampToken({
      digest,
      now: new Date(),
      token,
    });
    expect(Buffer.from(validated.signerCertificate)).toEqual(
      Buffer.from(signer.der),
    );
  });

  test("refuses a token whose imprint is not this signature's", async () => {
    const signer = await createTestTimestampCertificate();
    const token = await issueTestTimestampToken({
      digest,
      misbehaviour: { imprint: new Uint8Array(32).fill(1) },
      serial: 1,
      signer,
    });

    expect(await refused(token)).toBeInstanceOf(
      PdfSigningTimestampInvalidError,
    );
  });

  test("refuses a token whose time is not current", async () => {
    const signer = await createTestTimestampCertificate();
    const token = await issueTestTimestampToken({
      digest,
      misbehaviour: { genTime: new Date("2020-01-01T00:00:00Z") },
      serial: 1,
      signer,
    });

    expect(await refused(token)).toBeInstanceOf(
      PdfSigningTimestampInvalidError,
    );
  });

  test("refuses a token signed by a key not meant for timestamping", async () => {
    const signer = await createTestTimestampCertificate({
      extendedKeyUsages: ["1.3.6.1.5.5.7.3.1"],
    });
    const token = await issueTestTimestampToken({ digest, serial: 1, signer });

    expect(await refused(token)).toBeInstanceOf(
      PdfSigningTimestampInvalidError,
    );
  });

  test("refuses a timestamping usage that is not marked critical", async () => {
    const signer = await createTestTimestampCertificate({ critical: false });
    const token = await issueTestTimestampToken({ digest, serial: 1, signer });

    expect(await refused(token)).toBeInstanceOf(
      PdfSigningTimestampInvalidError,
    );
  });

  test("refuses a key that may also do something other than timestamping", async () => {
    const signer = await createTestTimestampCertificate({
      extendedKeyUsages: ["1.3.6.1.5.5.7.3.8", "1.3.6.1.5.5.7.3.1"],
    });
    const token = await issueTestTimestampToken({ digest, serial: 1, signer });

    expect(await refused(token)).toBeInstanceOf(
      PdfSigningTimestampInvalidError,
    );
  });

  test("refuses a token from a certificate that had expired by its time", async () => {
    const day = 86_400_000;
    const signer = await createTestTimestampCertificate({
      notAfter: new Date(Date.now() - day),
      notBefore: new Date(Date.now() - 30 * day),
    });
    const token = await issueTestTimestampToken({ digest, serial: 1, signer });

    expect(await refused(token)).toBeInstanceOf(
      PdfSigningTimestampInvalidError,
    );
  });

  test("refuses a token whose signature does not verify", async () => {
    const signer = await createTestTimestampCertificate();
    const other = await createTestTimestampCertificate();
    // Signed by one key, presenting another key's certificate.
    const token = await issueTestTimestampToken({
      digest,
      serial: 1,
      signer: { ...signer, privateKey: other.privateKey },
    });

    expect(await refused(token)).toBeInstanceOf(
      PdfSigningTimestampInvalidError,
    );
  });
});

describe("requesting a timestamp over the guarded fetcher", () => {
  const digest = crypto.getRandomValues(new Uint8Array(32));

  test("posts an RFC 3161 query and accepts the token that answers it", async () => {
    const responder = await createTestTimestampResponder();
    const authority = createHttpTimestampAuthority(
      "https://tsa.example/",
      responder.fetcher,
    );

    const token = await authority.timestamp(digest, "SHA-256");
    expect(token.byteLength).toBeGreaterThan(0);
    expect(responder.requests).toEqual([
      {
        contentType: "application/timestamp-query",
        url: "https://tsa.example/",
      },
    ]);
  });

  test("refuses a token that does not echo the request's nonce", async () => {
    const responder = await createTestTimestampResponder({
      misbehaviour: { dropNonce: true },
    });
    const authority = createHttpTimestampAuthority(
      "https://tsa.example/",
      responder.fetcher,
    );

    const failure = await authority
      .timestamp(digest, "SHA-256")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PdfSigningTimestampInvalidError);
  });

  test("treats an authority that cannot be reached as a failure", async () => {
    const authority = createHttpTimestampAuthority(
      "https://tsa.example/",
      async () => null,
    );

    const failure = await authority
      .timestamp(digest, "SHA-256")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PdfSigningTimestampInvalidError);
  });
});
