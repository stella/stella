import { Result } from "better-result";
import { expect, test } from "bun:test";
import { dkimSign, dkimVerify } from "mailauth";
import { generateKeyPairSync } from "node:crypto";

import { createOriginalSignatureVerifier } from "./authentication";
import {
  ingestInboundMail,
  type PersistInboundDeliveryOptions,
} from "./ingest";
import { INBOUND_MAIL_LIMITS } from "./limits";
import { parseInboundMessage } from "./message";

const original = Buffer.from(
  [
    "From: Author <author@outside.test>",
    "To: Member <member@example.test>",
    "Subject: Signed original",
    "Date: Fri, 25 Sep 2026 11:00:00 +0000",
    "Message-ID: <signed-original@outside.test>",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Original body",
    "",
  ].join("\r\n"),
);

const attachOriginal = (raw: Uint8Array) =>
  new TextEncoder().encode(
    [
      "From: Member <member@example.test>",
      "To: Matter <matter@example.test>",
      "Subject: Fwd: Signed original",
      "Date: Sat, 26 Sep 2026 12:00:00 +0000",
      "Message-ID: <forward-wrapper@example.test>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      "Content-Type: message/rfc822",
      'Content-Disposition: attachment; filename="original.eml"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(raw).toString("base64"),
      "--outer--",
      "",
    ].join("\r\n"),
  );

test("verifies only a complete DKIM signature over the exact attached original bytes", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicKeyRecord = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const resolver = () => ({
    resolve: async (domain: string, rrtype: string) => {
      if (domain === "case._domainkey.outside.test" && rrtype === "TXT") {
        return [[`v=DKIM1; k=rsa; p=${publicKeyRecord}`]];
      }
      return [];
    },
    cancel: () => {},
  });
  const verify = createOriginalSignatureVerifier(resolver);
  const sign = async (maxBodyLength?: number) => {
    const signed = await dkimSign(original, {
      signTime: "2026-09-26T00:00:00.000Z",
      signatureData: [
        {
          signingDomain: "outside.test",
          selector: "case",
          privateKey: privateKeyPem,
          ...(maxBodyLength === undefined ? {} : { maxBodyLength }),
        },
      ],
    });
    expect(signed.errors).toEqual([]);
    return Buffer.concat([Buffer.from(signed.signatures), original]);
  };

  const signed = await sign();
  const parsed = await parseInboundMessage(attachOriginal(signed));
  expect(parsed.forwardSource).toBe("attached");
  if (parsed.forwardSource !== "attached") {
    return;
  }
  expect(parsed.outerSender).toBe("member@example.test");
  expect(parsed.message.from).toBe("author@outside.test");
  expect(Buffer.from(parsed.originalRaw)).toEqual(signed);
  const signedVerdict = await verify(parsed.originalRaw);
  expect(signedVerdict.isOk() && signedVerdict.value).toEqual({
    status: "verified",
    domain: "outside.test",
  });

  const deliveries: PersistInboundDeliveryOptions[] = [];
  const ingested = await ingestInboundMail({
    raw: attachOriginal(signed),
    envelope: {
      mailFrom: "member@example.test",
      recipients: [`${"a".repeat(64)}@inbound.example.test`],
      remoteIp: "192.0.2.1",
      helo: "mail.example.test",
    },
    receivedAt: "2026-09-26T12:00:00.000Z",
    inboundDomain: "inbound.example.test",
    verify: async () =>
      Result.ok({
        source: "provider" as const,
        evidence: "identifiers" as const,
        fromDomain: "example.test",
        spf: {
          result: "pass" as const,
          domain: "example.test",
          alignment: "strict" as const,
        },
        dkim: [],
        dmarc: "pass" as const,
      }),
    verifyOriginal: verify,
    scan: "pass",
    persist: async (input) => {
      deliveries.push(input);
      return { status: "filed", correspondenceId: "record-1" };
    },
  });
  expect(ingested.isOk()).toBe(true);
  const delivery = deliveries.at(0)?.delivery;
  expect(delivery?.status).toBe("candidate");
  if (delivery?.status === "candidate") {
    expect(delivery.message.intake).toBe("forwarded_attachment");
    expect(delivery.message.from.address).toBe("author@outside.test");
    expect(delivery.message.originalSignature).toEqual({
      status: "verified",
      domain: "outside.test",
    });
    expect(delivery.message.authenticatedSender).toMatchObject({
      address: "member@example.test",
      alignedIdentifier: "example.test",
      dmarc: "pass",
    });
  }

  const tamperedBody = Buffer.from(
    signed.toString().replace("Original body", "Tampered body"),
  );
  expect(tamperedBody).not.toEqual(signed);
  const bodyVerdict = await verify(tamperedBody);
  expect(bodyVerdict.isOk() && bodyVerdict.value).toEqual({
    status: "unverified",
  });

  const tamperedSignature = Buffer.from(
    signed
      .toString()
      .replace(
        /\bb=([A-Za-z0-9+/])/u,
        (_match, first: string) => `b=${first === "A" ? "B" : "A"}`,
      ),
  );
  expect(tamperedSignature).not.toEqual(signed);
  const signatureVerdict = await verify(tamperedSignature);
  expect(signatureVerdict.isOk() && signatureVerdict.value).toEqual({
    status: "unverified",
  });

  const unsignedVerdict = await verify(original);
  expect(unsignedVerdict.isOk() && unsignedVerdict.value).toEqual({
    status: "unverified",
  });

  const partial = await sign(5);
  expect(partial.toString()).toMatch(/\bl=5\b/u);
  const libraryVerdict = await dkimVerify(partial, {
    resolver: resolver().resolve,
  });
  const partialSignature = libraryVerdict.results.at(0);
  expect(partialSignature?.status.result).toBe("pass");
  expect(partialSignature?.status.underSized).toBeGreaterThan(0);
  const partialVerdict = await verify(partial);
  expect(partialVerdict.isOk() && partialVerdict.value).toEqual({
    status: "unverified",
  });

  const signatureHeader = signed
    .subarray(0, signed.length - original.length)
    .toString();
  expect(signatureHeader).toMatch(/\bs=case\b/u);
  const signatures = Array.from(
    { length: INBOUND_MAIL_LIMITS.dnsQueries + 1 },
    (_, index) =>
      signatureHeader.replace(/\bs=case\b/u, () => `s=case${index}`),
  );
  const dnsExhausted = Buffer.concat([
    Buffer.from(signatures.join("")),
    original,
  ]);
  let dnsLookups = 0;
  const verifyWithBudget = createOriginalSignatureVerifier(() => ({
    resolve: async (domain: string, rrtype: string) => {
      if (rrtype === "TXT" && domain.endsWith("._domainkey.outside.test")) {
        dnsLookups += 1;
        return [[`v=DKIM1; k=rsa; p=${publicKeyRecord}`]];
      }
      return [];
    },
    cancel: () => {},
  }));
  const exhaustedVerdict = await verifyWithBudget(dnsExhausted);
  expect(dnsLookups).toBe(INBOUND_MAIL_LIMITS.dnsQueries);
  expect(exhaustedVerdict.isOk() && exhaustedVerdict.value).toEqual({
    status: "unverified",
  });
});
