import { describe, expect, test } from "bun:test";
import { dkimSign } from "mailauth";
import { generateKeyPairSync } from "node:crypto";

import {
  createMailDnsResolver,
  createLocalMailVerifier,
  domainsAlign,
  hasAlignedAuthentication,
  parseProviderAuthentication,
  verifyMailLocally,
  type MailAuthentication,
} from "@/api/lib/email/inbound/authentication";

const provider = (value: string) =>
  parseProviderAuthentication({
    authenticationResults: `mx.example.test; ${value}`,
    authservId: "mx.example.test",
    fromAddress: "member@example.com",
  });

describe("mail authentication trust boundary", () => {
  test.each([
    "pass",
    "fail",
    "none",
    "neutral",
    "softfail",
    "temperror",
    "permerror",
  ])("requires both DMARC and aligned authentication: %s", (verdict) => {
    const result = provider(
      `spf=${verdict} smtp.mailfrom=member@example.com; dmarc=pass header.from=example.com`,
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(hasAlignedAuthentication(result.value, "member@example.com")).toBe(
        verdict === "pass",
      );
    }
  });

  test.each([
    "spf=pass smtp.mailfrom=member@attacker.com; dmarc=pass header.from=example.com",
    "spf=pass smtp.mailfrom=member@example.com; dmarc=none header.from=example.com",
    "dkim=pass header.d=attacker.com; dmarc=pass header.from=example.com",
    "dkim=pass header.d=example.com; dmarc=pass header.from=attacker.com",
    "arc=pass; dmarc=pass header.from=example.com",
  ])("cannot turn unrelated authentication into sender proof: %s", (value) => {
    const result = provider(value);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(hasAlignedAuthentication(result.value, "member@example.com")).toBe(
        false,
      );
    }
  });

  test("accepts aligned DKIM when SPF fails and handles comments and folding removed by the adapter", () => {
    const result = provider(
      'spf=fail (comment; (nested)); dkim=fail header.d=other.test; dkim=pass header.d="example.com"; dmarc=pass header.from=example.com',
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(hasAlignedAuthentication(result.value, "member@example.com")).toBe(
        true,
      );
      expect(hasAlignedAuthentication(result.value, "member@other.test")).toBe(
        false,
      );
    }
  });

  test.each([
    "spf=pass smtp.mailfrom=example.com; spf=fail smtp.mailfrom=other.test",
    "dkim=pass header.d=example.com header.d=other.test",
    "dkim=pass (unterminated",
    'dkim=pass header.d="example.com',
    "dkim=pass header.d=example.com\r\nAuthentication-Results: mx.example.test; dmarc=pass",
  ])("rejects ambiguous or malformed provider evidence: %s", (value) => {
    expect(provider(value).isErr()).toBe(true);
  });

  test("rejects an unexpected authentication server", () => {
    expect(
      parseProviderAuthentication({
        authenticationResults: "evil.test; spf=pass",
        authservId: "mx.example.test",
        fromAddress: "member@example.com",
      }).isErr(),
    ).toBe(true);
  });

  test("relaxed alignment respects public and private suffix boundaries", () => {
    for (const [fromDomain, authenticatedDomain, expected] of [
      ["team.example.co.uk", "mail.example.co.uk", true],
      ["example.co.uk", "attacker.co.uk", false],
      ["alice.github.io", "bob.github.io", false],
      ["example.com", "example.com.evil.test", false],
      ["example.com", "evil-example.com", false],
    ] as const) {
      expect(
        domainsAlign({ fromDomain, authenticatedDomain, mode: "relaxed" }),
      ).toBe(expected);
      expect(
        domainsAlign({ fromDomain, authenticatedDomain, mode: "strict" }),
      ).toBe(false);
    }
  });

  test("strict policy rejects sibling subdomains", () => {
    const auth = {
      source: "local",
      evidence: "identifiers",
      fromDomain: "example.com",
      spf: { result: "pass", domain: "mail.example.com", alignment: "strict" },
      dkim: [],
      dmarc: "pass",
    } satisfies MailAuthentication;
    expect(hasAlignedAuthentication(auth, "member@example.com")).toBe(false);
  });

  test("local verification fails before DNS for an absent SMTP peer", async () => {
    const result = await verifyMailLocally({
      raw: new Uint8Array(),
      fromAddress: "member@example.com",
      envelope: {
        mailFrom: "member@example.com",
        recipients: [],
        remoteIp: "",
        helo: "mail.example.com",
      },
    });
    expect(result.isErr()).toBe(true);
  });
});

test("local verification uses SMTP envelope and DNS, ignoring forged authentication headers", async () => {
  let cancelled = 0;
  const verifier = createLocalMailVerifier(() => ({
    resolve: async (domain, rrtype) => {
      if (rrtype !== "TXT") {
        return [];
      }
      if (domain === "example.com") {
        return [["v=spf1 ip4:192.0.2.1 -all"]];
      }
      if (domain === "_dmarc.example.com") {
        return [["v=DMARC1; p=reject; aspf=s"]];
      }
      return [];
    },
    cancel: () => {
      cancelled += 1;
    },
  }));
  const raw = new TextEncoder().encode(
    "From: member@example.com\r\nTo: recipient@example.net\r\nAuthentication-Results: mx.example.com; spf=pass; dmarc=pass header.from=example.com\r\nReceived: from mail.example.com (mail.example.com [192.0.2.1])\r\n\r\nBody",
  );
  for (const remoteIp of ["192.0.2.1", "192.0.2.2"]) {
    const auth = await verifier({
      raw,
      fromAddress: "member@example.com",
      envelope: {
        mailFrom: "member@example.com",
        recipients: ["token@inbound.example.com"],
        remoteIp,
        helo: "mail.example.com",
      },
    });
    expect(auth.isOk()).toBe(true);
    if (auth.isErr()) {
      continue;
    }
    expect(hasAlignedAuthentication(auth.value, "member@example.com")).toBe(
      remoteIp === "192.0.2.1",
    );
  }
  expect(cancelled).toBe(2);
});

test("local verification resolves SPF MX hosts through the mail DNS adapter", async () => {
  const queried: string[] = [];
  let cancelled = 0;
  const verifier = createLocalMailVerifier(() =>
    createMailDnsResolver({
      resolveTxt: async (domain) => {
        queried.push(`TXT ${domain}`);
        if (domain === "example.com") {
          return [["v=spf1 mx -all"]];
        }
        if (domain === "_dmarc.example.com") {
          return [["v=DMARC1; p=reject; aspf=s"]];
        }
        return [];
      },
      resolveMx: async (domain) => {
        queried.push(`MX ${domain}`);
        return domain === "example.com"
          ? [{ priority: 10, exchange: "mail.example.com" }]
          : [];
      },
      resolve4: async (domain) => {
        queried.push(`A ${domain}`);
        return domain === "mail.example.com" ? ["192.0.2.1"] : [];
      },
      resolve6: async () => [],
      resolvePtr: async () => [],
      cancel: () => {
        cancelled += 1;
      },
    }),
  );
  const raw = new TextEncoder().encode(
    "From: member@example.com\r\nTo: recipient@example.net\r\n\r\nBody",
  );
  for (const remoteIp of ["192.0.2.1", "192.0.2.2"]) {
    const result = await verifier({
      raw,
      fromAddress: "member@example.com",
      envelope: {
        mailFrom: "member@example.com",
        recipients: ["token@inbound.example.com"],
        remoteIp,
        helo: "mail.example.com",
      },
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      continue;
    }
    expect(result.value.spf.result).toBe(
      remoteIp === "192.0.2.1" ? "pass" : "fail",
    );
    expect(hasAlignedAuthentication(result.value, "member@example.com")).toBe(
      remoteIp === "192.0.2.1",
    );
  }
  expect(queried).toContain("MX example.com");
  expect(queried).toContain("A mail.example.com");
  expect(cancelled).toBe(2);
});

test("local verification validates DKIM bytes, alignment, and DMARC policy", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicKeyRecord = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const unsigned = Buffer.from(
    "From: member@example.com\r\nTo: recipient@example.net\r\nSubject: local DKIM check\r\n\r\nOriginal body\r\n",
  );
  const makeSignedMessage = async (signingDomain: string) => {
    const signed = await dkimSign(unsigned, {
      signTime: new Date("2026-09-26T00:00:00.000Z"),
      signatureData: [
        {
          signingDomain,
          selector: "local-test",
          privateKey: privateKeyPem,
        },
      ],
    });
    expect(signed.errors).toEqual([]);
    return Buffer.concat([Buffer.from(signed.signatures), unsigned]);
  };
  const verify = (raw: Uint8Array) =>
    createLocalMailVerifier(() => ({
      resolve: async (domain, rrtype) => {
        if (rrtype !== "TXT") {
          return [];
        }
        if (domain === "example.com") {
          return [["v=spf1 -all"]];
        }
        if (domain === "_dmarc.example.com") {
          return [["v=DMARC1; p=reject; aspf=s; adkim=s"]];
        }
        if (
          domain === "local-test._domainkey.example.com" ||
          domain === "local-test._domainkey.attacker.example.net"
        ) {
          return [[`v=DKIM1; k=rsa; p=${publicKeyRecord}`]];
        }
        return [];
      },
      cancel: () => {},
    }))({
      raw,
      fromAddress: "member@example.com",
      envelope: {
        mailFrom: "member@example.com",
        recipients: ["token@inbound.example.com"],
        remoteIp: "192.0.2.99",
        helo: "mail.example.com",
      },
    });

  const aligned = await makeSignedMessage("example.com");
  const accepted = await verify(aligned);
  expect(accepted.isOk()).toBe(true);
  if (accepted.isOk()) {
    expect(accepted.value.spf.result).toBe("fail");
    expect(accepted.value.dkim).toContainEqual({
      result: "pass",
      domain: "example.com",
      alignment: "strict",
    });
    expect(accepted.value.dmarc).toBe("pass");
    expect(hasAlignedAuthentication(accepted.value, "member@example.com")).toBe(
      true,
    );
  }

  const tampered = Buffer.from(aligned);
  tampered[tampered.length - 2] = 0x58;
  const rejectedBody = await verify(tampered);
  expect(rejectedBody.isOk()).toBe(true);
  if (rejectedBody.isOk()) {
    expect(
      rejectedBody.value.dkim.some(({ result }) => result === "pass"),
    ).toBe(false);
    expect(rejectedBody.value.dmarc).toBe("fail");
    expect(
      hasAlignedAuthentication(rejectedBody.value, "member@example.com"),
    ).toBe(false);
  }

  const unaligned = await makeSignedMessage("attacker.example.net");
  const rejectedAlignment = await verify(unaligned);
  expect(rejectedAlignment.isOk()).toBe(true);
  if (rejectedAlignment.isOk()) {
    expect(rejectedAlignment.value.dkim).toContainEqual({
      result: "pass",
      domain: "attacker.example.net",
      alignment: "strict",
    });
    expect(rejectedAlignment.value.dmarc).toBe("fail");
    expect(
      hasAlignedAuthentication(rejectedAlignment.value, "member@example.com"),
    ).toBe(false);
  }
});
