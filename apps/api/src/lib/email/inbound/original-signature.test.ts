import { Result } from "better-result";
import { expect, test } from "bun:test";
import { authenticate, dkimSign, dkimVerify } from "mailauth";
import { generateKeyPairSync } from "node:crypto";

import {
  createLocalMailVerifier,
  createOriginalSignatureVerifier,
} from "./authentication";
import {
  ingestInboundMail,
  type InboundDeliveryOutcome,
  type PersistInboundDeliveryOptions,
} from "./ingest";
import { INBOUND_MAIL_LIMITS } from "./limits";
import { parseInboundMessage } from "./message";

const original = Buffer.from(
  [
    "From: =?UTF-8?Q?Ji=C5=99=C3=AD_Nov=C3=A1k?= <author@outside.test>",
    "To: Member <member@example.test>",
    "Subject: =?UTF-8?Q?Podepsan=C3=A1_zpr=C3=A1va?=",
    "Date: Fri, 25 Sep 2026 11:00:00 +0000",
    "Message-ID: <signed-original@outside.test>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="signed-parts"',
    "",
    "--signed-parts",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Original body",
    "--signed-parts",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="document.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjcK",
    "--signed-parts--",
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

test("verifies a raw multipart fixture with genuine DKIM, ARC, SPF and DMARC results", async () => {
  // Store the fixture with repository line endings; restore the signed SMTP bytes.
  const raw = Buffer.from(
    (
      await Bun.file(
        new URL("fixtures/authenticated-multipart.eml", import.meta.url),
      ).text()
    ).replaceAll("\n", "\r\n"),
  );
  const key = (
    await Bun.file(
      new URL("fixtures/authenticated-multipart-key.txt", import.meta.url),
    ).text()
  ).trim();
  const resolve = async (domain: string, rrtype: string) => {
    if (rrtype !== "TXT") {
      return [];
    }
    switch (domain) {
      case "case._domainkey.outside.test":
        return [[key]];
      case "outside.test":
        return [["v=spf1 ip4:192.0.2.1 -all"]];
      case "_dmarc.outside.test":
        return [["v=DMARC1; p=reject; adkim=s; aspf=s"]];
      default:
        return [];
    }
  };
  const options = {
    resolver: resolve,
    sender: "author@outside.test",
    ip: "192.0.2.1",
    helo: "mail.outside.test",
    mta: "mx.example.test",
    disableBimi: true,
  };
  const results = await authenticate(raw, options);
  expect(results.dkim.results.at(0)?.status.result).toBe("pass");
  expect(results.spf.status.result).toBe("pass");
  expect(results.dmarc && results.dmarc.status.result).toBe("pass");
  expect(results.arc && results.arc.status.result).toBe("pass");
  const verify = createLocalMailVerifier(() => ({ resolve, cancel: () => {} }));
  const verdict = await verify({
    raw,
    fromAddress: "author@outside.test",
    envelope: {
      mailFrom: "author@outside.test",
      recipients: ["member@example.test"],
      remoteIp: "192.0.2.1",
      helo: "mail.outside.test",
    },
  });
  expect(verdict.unwrap()).toMatchObject({
    spf: { result: "pass", alignment: "strict" },
    dkim: [{ result: "pass", domain: "outside.test", alignment: "strict" }],
    dmarc: "pass",
  });
  const parsed = (await parseInboundMessage(raw)).unwrap();
  expect(parsed.message.subject).toBe("Podepsaná zpráva");
  expect(parsed.message.text).toBe("Original body");
  expect(parsed.message.attachments).toMatchObject([
    {
      fileName: "document.pdf",
      bytes: new TextEncoder().encode("%PDF-1.7\n"),
    },
  ]);
  const tampered = await authenticate(
    Buffer.from(raw.toString().replace("Original body", "Tampered body")),
    { ...options, ip: "192.0.2.99" },
  );
  expect(tampered.dkim.results.at(0)?.status).toMatchObject({
    result: "neutral",
    comment: "body hash did not verify",
  });
  expect(tampered.spf.status.result).toBe("fail");
  expect(tampered.dmarc && tampered.dmarc.status.result).toBe("fail");
  expect(tampered.arc && tampered.arc.status.result).toBe("fail");
});

test("verifies only a complete DKIM signature over the exact attached original bytes", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
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
  const parsed = (await parseInboundMessage(attachOriginal(signed))).unwrap();
  expect(parsed.forwardSource).toBe("attached");
  if (parsed.forwardSource !== "attached") {
    return;
  }
  expect(parsed.outerSender).toBe("member@example.test");
  expect(parsed.message.from).toBe("author@outside.test");
  expect(parsed.message.subject).toBe("Podepsaná zpráva");
  expect(parsed.message.text).toBe("Original body");
  expect(parsed.message.attachments).toMatchObject([
    {
      fileName: "document.pdf",
      mimeType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.7\n"),
    },
  ]);
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
      return Result.ok({
        status: "filed",
        correspondenceId: "record-1",
      } as const satisfies InboundDeliveryOutcome);
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

for (const separator of ["\r\n\r\n", "\n\n", ""]) {
  test.each([-1, 0, 1, 1024])(
    `bounds original headers before creating a DNS resolver (separator ${JSON.stringify(separator)}, offset %d)`,
    async (offset) => {
      const headerBytes = INBOUND_MAIL_LIMITS.headerBytes + offset;
      const prefix = "X-Padding: ";
      const body = separator === "" ? "" : "Body";
      const raw = Buffer.from(
        prefix + "a".repeat(headerBytes - prefix.length) + separator + body,
      );
      expect(raw.byteLength).toBe(headerBytes + separator.length + body.length);
      let resolverCreations = 0;
      const verify = createOriginalSignatureVerifier(() => {
        resolverCreations += 1;
        return { resolve: async () => [], cancel: () => {} };
      });
      const result = await verify(raw);
      expect(result.unwrap()).toEqual({ status: "unverified" });
      expect(resolverCreations).toBe(offset <= 0 ? 1 : 0);
    },
  );
}
