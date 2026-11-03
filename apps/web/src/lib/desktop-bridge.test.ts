import { describe, expect, test } from "bun:test";

import { DESKTOP_ACCOUNT_POLICY } from "@stll/api-contract/desktop-registry";
import type { FetchWithTimeoutInit } from "@stll/fetch";

import {
  DesktopAccountConflictError,
  desktopAccountGrantRequest,
  desktopBridgeProofHeaders,
  parseDesktopAccountChallenge,
  readDesktopConnection,
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

type SignedDesktopStatusOptions = {
  status: string;
  timestamp: string;
  verifierHash?: string;
  deviceJkt?: string;
};

/** A status as the app signs it, by default for `challenge`. */
const signedDesktopStatus = ({
  status,
  timestamp,
  verifierHash = challenge.verifierHash,
  deviceJkt = challenge.deviceJkt,
}: SignedDesktopStatusOptions) => ({
  correlationId: challenge.correlationId,
  status,
  timestamp,
  proof: new Bun.CryptoHasher("sha256", challenge.portSecret)
    .update(
      `${challenge.correlationId}\n${verifierHash}\n${deviceJkt}\n${status}\n${timestamp}`,
    )
    .digest("hex"),
});

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
      "x-stella-bridge-proof": new Bun.CryptoHasher(
        "sha256",
        challenge.portSecret,
      )
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

  test("accepts only fresh connection responses signed for this whole challenge", async () => {
    const timestamp = "1790851200";
    for (const status of ["pending", "connected", "failed"] as const) {
      const payload = signedDesktopStatus({ status, timestamp });
      for (const nowSeconds of [1_790_851_170, 1_790_851_200, 1_790_851_230]) {
        expect(
          await verifyDesktopConnectionStatus({
            payload,
            challenge,
            nowSeconds,
          }),
        ).toBe(status);
      }
      const otherChallenge = (
        field: "verifierHash" | "deviceJkt" | "portSecret",
        value: string,
      ) => ({ ...challenge, [field]: value });
      for (const invalid of [
        // Outside the skew window in either direction.
        { payload, nowSeconds: 1_790_851_231, challenge },
        { payload, nowSeconds: 1_790_851_169, challenge },
        {
          payload,
          nowSeconds: 1_790_851_200,
          challenge: otherChallenge("portSecret", "c".repeat(64)),
        },
        // A status the app signed for another verifier or device key.
        {
          payload,
          nowSeconds: 1_790_851_200,
          challenge: otherChallenge("verifierHash", "c".repeat(64)),
        },
        {
          payload,
          nowSeconds: 1_790_851_200,
          challenge: otherChallenge("deviceJkt", "B".repeat(43)),
        },
        {
          payload: signedDesktopStatus({
            status,
            timestamp,
            verifierHash: "c".repeat(64),
          }),
          nowSeconds: 1_790_851_200,
          challenge,
        },
        {
          payload: signedDesktopStatus({
            status,
            timestamp,
            deviceJkt: "B".repeat(43),
          }),
          nowSeconds: 1_790_851_200,
          challenge,
        },
        // The signature format before the challenge was bound.
        {
          payload: {
            ...payload,
            proof: new Bun.CryptoHasher("sha256", challenge.portSecret)
              .update(`${challenge.correlationId}\n${status}\n${timestamp}`)
              .digest("hex"),
          },
          nowSeconds: 1_790_851_200,
          challenge,
        },
        {
          payload: { ...payload, correlationId: "other" },
          nowSeconds: 1_790_851_200,
          challenge,
        },
        {
          payload: { ...payload, timestamp: "1790851201" },
          nowSeconds: 1_790_851_200,
          challenge,
        },
        {
          payload: {
            ...payload,
            status: status === "connected" ? "pending" : "connected",
          },
          nowSeconds: 1_790_851_200,
          challenge,
        },
        {
          payload: { ...payload, proof: "0".repeat(64) },
          nowSeconds: 1_790_851_200,
          challenge,
        },
        {
          payload: { ...payload, status: "unknown" },
          nowSeconds: 1_790_851_200,
          challenge,
        },
        {
          payload: { ...payload, timestamp: "NaN" },
          nowSeconds: 1_790_851_200,
          challenge,
        },
      ]) {
        expect(await verifyDesktopConnectionStatus(invalid)).toBeNull();
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
          challenge,
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

test("binds the account grant to every validated native challenge field", () => {
  expect(desktopAccountGrantRequest(challenge)).toEqual({
    correlationId: challenge.correlationId,
    verifierHash: challenge.verifierHash,
    deviceJkt: challenge.deviceJkt,
  });
});

test("sends every browser loopback request as a credentialless GET", async () => {
  const requests: {
    input: string | URL | Request;
    init?: FetchWithTimeoutInit;
  }[] = [];
  await readDesktopConnection({
    challenge,
    request: async (input, init) => {
      requests.push({ input, init });
      return new Response(null, { status: 503 });
    },
  });

  expect(requests).toHaveLength(1);
  for (const { input, init } of requests) {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    expect(url.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(url.pathname).toBe("/v1/connection");
    expect(url.searchParams.get("correlationId")).toBe(challenge.correlationId);
    expect([...url.searchParams.keys()]).toEqual(["correlationId"]);
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("omit");
    expect(init?.referrerPolicy).toBe("no-referrer");
    expect(init?.body).toBeUndefined();
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(JSON.stringify({ url: url.href, init })).not.toContain(
      challenge.portSecret,
    );
  }
});
