import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

import { DESKTOP_ACCOUNT_POLICY } from "@stll/api-contract/desktop-registry";

import {
  DesktopAccountConflictError,
  desktopBridgeProofHeaders,
  parseDesktopAccountChallenge,
  resolveDesktopAccountLink,
  verifyDesktopConnectionStatus,
} from "@/lib/desktop-bridge";

const challenge = {
  correlationId: "90123344-5566-7788-9900-aabbccddeeff",
  verifierHash: "a".repeat(64),
  deviceJkt: "A".repeat(43),
  portSecret: "b".repeat(64),
  protocol: String(DESKTOP_ACCOUNT_POLICY.linkProtocol),
};
const fragment = `#desktop-account?${new URLSearchParams(challenge).toString()}`;

describe("account link challenges", () => {
  test("accepts a complete native challenge", () => {
    expect(parseDesktopAccountChallenge(fragment) !== null).toBe(true);
    expect(parseDesktopAccountChallenge(fragment)).toEqual(challenge);
  });

  test("rejects legacy challenges and malformed device thumbprints", () => {
    for (const deviceJkt of [
      "",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}+`,
      `${"A".repeat(42)}/`,
    ]) {
      const params = new URLSearchParams({ ...challenge, deviceJkt });
      expect(
        parseDesktopAccountChallenge(`#desktop-account?${params.toString()}`),
      ).toBeNull();
    }
    for (const protocol of ["4", String(DESKTOP_ACCOUNT_POLICY.linkProtocol)]) {
      const params = new URLSearchParams({ ...challenge, protocol });
      params.delete("deviceJkt");
      expect(
        parseDesktopAccountChallenge(`#desktop-account?${params.toString()}`),
      ).toBeNull();
    }
  });

  test("rejects missing, duplicate, malformed, and extra fields", () => {
    for (const key of Object.keys(challenge)) {
      const missing = new URLSearchParams(challenge);
      missing.delete(key);
      expect(
        parseDesktopAccountChallenge(
          `#desktop-account?${missing.toString()}`,
        ) !== null,
      ).toBe(false);
      const duplicate = new URLSearchParams(challenge);
      duplicate.append(key, "value");
      expect(
        parseDesktopAccountChallenge(
          `#desktop-account?${duplicate.toString()}`,
        ) !== null,
      ).toBe(false);
      const malformed = new URLSearchParams(challenge);
      malformed.set(key, "value");
      expect(
        parseDesktopAccountChallenge(
          `#desktop-account?${malformed.toString()}`,
        ) !== null,
      ).toBe(false);
    }
    for (const hash of [
      "#desktop-account",
      "#desktop-account=secret",
      "#desktop-registry=nonce",
      `${fragment}&verifier=secret`,
      `${fragment}&credential=secret`,
      `${fragment}&unknown=value`,
    ]) {
      expect(parseDesktopAccountChallenge(hash) !== null).toBe(false);
    }
  });
});

describe("authenticated account status", () => {
  test("sends a request-bound proof without the port secret", async () => {
    const path =
      "/v1/connection?correlationId=90123344-5566-7788-9900-aabbccddeeff";
    const timestamp = "1790851200";
    const headers = await desktopBridgeProofHeaders({
      portSecret: challenge.portSecret,
      timestamp,
      path,
    });
    expect(headers).toEqual({
      "x-stella-bridge-time": timestamp,
      "x-stella-bridge-proof": createHmac("sha256", challenge.portSecret)
        .update(`${timestamp}\nGET\n${path}`)
        .digest("hex"),
    });
    expect(JSON.stringify(headers)).not.toContain(challenge.portSecret);
    for (const changed of [
      { portSecret: "c".repeat(64), timestamp, path },
      { portSecret: challenge.portSecret, timestamp: "1790851201", path },
      {
        portSecret: challenge.portSecret,
        timestamp,
        path: `${path}&other=value`,
      },
    ]) {
      expect(
        (await desktopBridgeProofHeaders(changed))["x-stella-bridge-proof"],
      ).not.toBe(headers["x-stella-bridge-proof"]);
    }
  });

  test("accepts only fresh connection responses authenticated for this attempt", async () => {
    const timestamp = "1790851200";
    for (const status of ["pending", "connected", "failed"] as const) {
      const payload = {
        correlationId: challenge.correlationId,
        status,
        timestamp,
        proof: createHmac("sha256", challenge.portSecret)
          .update(`${challenge.correlationId}\n${status}\n${timestamp}`)
          .digest("hex"),
      };
      for (const nowSeconds of [1_790_851_170, 1_790_851_200, 1_790_851_230]) {
        expect(
          await verifyDesktopConnectionStatus({
            payload,
            correlationId: challenge.correlationId,
            portSecret: challenge.portSecret,
            nowSeconds,
          }),
        ).toBe(status);
      }
      for (const invalid of [
        {
          payload,
          nowSeconds: 1_790_851_231,
          portSecret: challenge.portSecret,
        },
        {
          payload,
          nowSeconds: 1_790_851_169,
          portSecret: challenge.portSecret,
        },
        { payload, nowSeconds: 1_790_851_200, portSecret: "c".repeat(64) },
        {
          payload: { ...payload, correlationId: "other" },
          nowSeconds: 1_790_851_200,
          portSecret: challenge.portSecret,
        },
        {
          payload: { ...payload, timestamp: "1790851201" },
          nowSeconds: 1_790_851_200,
          portSecret: challenge.portSecret,
        },
        {
          payload: {
            ...payload,
            status: status === "connected" ? "pending" : "connected",
          },
          nowSeconds: 1_790_851_200,
          portSecret: challenge.portSecret,
        },
        {
          payload: { ...payload, proof: "0".repeat(64) },
          nowSeconds: 1_790_851_200,
          portSecret: challenge.portSecret,
        },
        {
          payload: { ...payload, status: "unknown" },
          nowSeconds: 1_790_851_200,
          portSecret: challenge.portSecret,
        },
        {
          payload: { ...payload, timestamp: "NaN" },
          nowSeconds: 1_790_851_200,
          portSecret: challenge.portSecret,
        },
      ]) {
        expect(
          await verifyDesktopConnectionStatus({
            ...invalid,
            correlationId: challenge.correlationId,
          }),
        ).toBeNull();
      }
    }
  });

  test("unsigned status and incomplete proofs are rejected", async () => {
    for (const payload of [
      { status: "connected" },
      {
        status: "connected",
        correlationId: challenge.correlationId,
        timestamp: "1790851200",
      },
      {
        status: "connected",
        correlationId: challenge.correlationId,
        timestamp: "1790851200",
        proof: "bad",
      },
      null,
      "connected",
    ]) {
      expect(
        await verifyDesktopConnectionStatus({
          payload,
          correlationId: challenge.correlationId,
          portSecret: challenge.portSecret,
          nowSeconds: 1_790_851_200,
        }),
      ).toBeNull();
    }
  });

  const browserAccount = {
    identity: { userId: "user-1", organizationId: "org-1" },
    email: "existing@example.com",
    name: "Example",
    verifiedAt: "2026-09-12T20:00:00.000Z",
  };
  const linkedIdentity = browserAccount.identity;

  test("reports success only for the browser account identity", () => {
    const outcome = resolveDesktopAccountLink({
      browserAccount,
      linkedIdentity,
    });
    expect(outcome.isOk()).toBe(true);
    if (outcome.isOk()) {
      expect(outcome.value).toBe(browserAccount.email);
    }
    for (const identity of [
      { userId: "user-1", organizationId: "org-2" },
      { userId: "user-2", organizationId: "org-1" },
      { userId: "user-2", organizationId: "org-2" },
    ]) {
      const mismatch = resolveDesktopAccountLink({
        browserAccount: { ...browserAccount, identity },
        linkedIdentity,
      });
      expect(mismatch.isErr()).toBe(true);
      if (mismatch.isErr()) {
        expect(mismatch.error).toBeInstanceOf(DesktopAccountConflictError);
      }
    }
  });
});

test("the actual grant request binds the validated native device thumbprint", async () => {
  const source = readFileSync(
    new URL("desktop-bridge.ts", import.meta.url),
    "utf-8",
  );
  const request = source
    .match(/await api\["desktop-registry"\]\.grant\.post\(\{[\s\S]*?\}\)/u)
    ?.at(0);
  if (!request) {
    throw new TypeError("Desktop grant request must exist");
  }
  const calls: unknown[] = [];
  await new Script(`(async () => { ${request}; })()`).runInNewContext({
    challenge,
    api: {
      "desktop-registry": {
        grant: {
          post: async (body: unknown) => {
            calls.push(body);
          },
        },
      },
    },
  });
  expect(calls).toEqual([
    {
      correlationId: challenge.correlationId,
      verifierHash: challenge.verifierHash,
      deviceJkt: challenge.deviceJkt,
    },
  ]);
});

test("browser bridge traffic cannot post document sessions or credentials", () => {
  const source = readFileSync(
    new URL("desktop-bridge.ts", import.meta.url),
    "utf-8",
  );
  // Every browser loopback request in this owner must be a read; native pulls
  // document sessions and account credentials directly from the server.
  expect(source).not.toMatch(/method:\s*["']POST["']/u);
  expect(source).not.toContain("/v1/open-file");
  expect(source).not.toContain("/v1/link-account");
  expect(source).not.toContain('"desktop-edit-sessions"');
});
