import { describe, expect, test } from "bun:test";

import { SSO_DOMAIN_TXT_VALUE_PREFIX } from "@stll/api-contract/sso";

import {
  domainTxtInstruction,
  verifyDomainTxtRecord,
} from "@/api/lib/auth/sso-domain-verify";

describe("verifyDomainTxtRecord", () => {
  test("verifies when _stella-verification.<domain> holds the expected TXT token", async () => {
    const token = `${SSO_DOMAIN_TXT_VALUE_PREFIX}abc123`;
    const result = await verifyDomainTxtRecord({
      domain: "acme.example.com",
      expectedToken: token,
      resolveTxt: async (host) =>
        host === "_stella-verification.acme.example.com" ? [[token]] : [],
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        status: "verified",
        matchedHost: "_stella-verification.acme.example.com",
      });
    }
  });

  test("falls back to checking the apex domain and joins split TXT chunks", async () => {
    const token = "stella-sso-verify=split-token";
    const result = await verifyDomainTxtRecord({
      domain: "acme.example.com",
      expectedToken: token,
      resolveTxt: async (host) =>
        host === "acme.example.com"
          ? [["stella-sso-verify=", "split-token"]]
          : [],
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        status: "verified",
        matchedHost: "acme.example.com",
      });
    }
  });

  test("treats ENOTFOUND/ENODATA as not_found rather than a transport error", async () => {
    const result = await verifyDomainTxtRecord({
      domain: "missing.example.com",
      expectedToken: `${SSO_DOMAIN_TXT_VALUE_PREFIX}xyz`,
      resolveTxt: async () => {
        const error = new Error("not found");
        Object.assign(error, { code: "ENOTFOUND" });
        throw error;
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe("not_found");
    }
  });

  test("returns SsoDomainDnsError on timeout", async () => {
    const result = await verifyDomainTxtRecord({
      domain: "slow.example.com",
      expectedToken: `${SSO_DOMAIN_TXT_VALUE_PREFIX}xyz`,
      timeoutMs: 20,
      resolveTxt: async () => await new Promise(() => {}),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("sso_domain_dns_error");
    }
  });

  test("domainTxtInstruction formats host and value without double prefixing", () => {
    expect(domainTxtInstruction("acme.com", "stella-sso-verify=tok")).toEqual({
      txtHost: "_stella-verification.acme.com",
      txtValue: "stella-sso-verify=tok",
    });
    expect(domainTxtInstruction("acme.com", "tok")).toEqual({
      txtHost: "_stella-verification.acme.com",
      txtValue: "stella-sso-verify=tok",
    });
  });
});
