import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { DesktopLinkStatus } from "@stll/api-contract/desktop-account-link";
import {
  DESKTOP_ACCOUNT_POLICY,
  DESKTOP_LINK_FAILURE_REASON_PROTOCOL,
} from "@stll/api-contract/desktop-registry";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { Temporal } from "@stll/time";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const originalFetch = globalThis.fetch;
// Auth initializes during imports; this suite owns the network boundary.
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: originalFetch.preconnect,
});

const {
  DesktopBridgeIncompatibleError,
  hasDesktopAccountChallenge,
  linkDesktopAccount,
} = await import("@/lib/desktop-bridge");

afterEach(() => {
  window.history.replaceState(null, "", "/");
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await unregisterDomEnvironment();
});

const challenge = {
  correlationId: "90123344-5566-7788-9900-aabbccddeeff",
  verifierHash: "a".repeat(64),
  deviceJkt: "A".repeat(43),
  portSecret: "b".repeat(64),
  protocol: String(DESKTOP_ACCOUNT_POLICY.linkProtocol),
};
const identity = {
  userId: "desktop-proof-test-user",
  organizationId: "desktop-proof-test-organization",
};

type DesktopSignature = {
  verifierHash: string;
  deviceJkt: string;
  portSecret: string;
  /** Seconds added to the current time when the app signs. */
  skewSeconds: number;
};

const SIGNED_BY_THE_LOCAL_APP = {
  verifierHash: challenge.verifierHash,
  deviceJkt: challenge.deviceJkt,
  portSecret: challenge.portSecret,
  skewSeconds: 0,
} as const satisfies DesktopSignature;

/** The status line the app signs: a failure signs its reason too. */
const signedLine = (status: DesktopLinkStatus) =>
  status.status === "failed" ? `failed:${status.reason}` : status.status;

type SignedReplyOptions = {
  payload: Readonly<Record<string, string>>;
  line: string;
  signature: DesktopSignature;
};

const signedReply = ({ payload, line, signature }: SignedReplyOptions) => {
  const timestamp = String(
    Math.floor(Temporal.Now.instant().epochMilliseconds / 1000) +
      signature.skewSeconds,
  );
  return Response.json({
    correlationId: challenge.correlationId,
    ...payload,
    timestamp,
    proof: new Bun.CryptoHasher("sha256", signature.portSecret)
      .update(
        `${challenge.correlationId}\n${signature.verifierHash}\n${signature.deviceJkt}\n${line}\n${timestamp}`,
      )
      .digest("hex"),
  });
};

const signedStatus = (status: DesktopLinkStatus, signature: DesktopSignature) =>
  signedReply({ payload: status, line: signedLine(status), signature });

const PENDING = { status: "pending" } as const;
const CONNECTED = { status: "connected" } as const;

type LoopbackReply = (phase: "before-grant" | "after-grant") => Response;

const requestUrl = (input: RequestInfo | URL) =>
  new URL(input instanceof Request ? input.url : String(input));

const requestBody = async (input: RequestInfo | URL, init?: RequestInit) => {
  if (input instanceof Request) {
    return await input.clone().text();
  }
  return typeof init?.body === "string" ? init.body : "";
};

/** Routes the page's requests: the app's loopback bridge, auth, and the grant. */
const scriptNetwork = (loopback: LoopbackReply) => {
  const grants: unknown[] = [];
  const loopbackRequests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.hostname === "127.0.0.1") {
        loopbackRequests.push(url.pathname);
        return loopback(grants.length === 0 ? "before-grant" : "after-grant");
      }
      if (url.pathname.endsWith("/desktop-registry/grant")) {
        grants.push(JSON.parse(await requestBody(input, init)));
        return Response.json({
          ...identity,
          expiresAt: Temporal.Now.instant()
            .add({ seconds: 60 })
            .toString({ fractionalSecondDigits: 3 }),
        });
      }
      if (url.pathname.endsWith("/get-session")) {
        return Response.json({
          user: {
            id: identity.userId,
            email: "desktop-proof@example.test",
            name: "Desktop proof test",
          },
          session: { activeOrganizationId: identity.organizationId },
        });
      }
      return Response.json(null);
    },
    { preconnect: originalFetch.preconnect },
  );
  return { grants, loopbackRequests };
};

const openChallenge = (protocol = challenge.protocol) => {
  window.history.replaceState(
    null,
    "",
    `/settings/account/desktop#desktop-account?${new URLSearchParams({ ...challenge, protocol }).toString()}`,
  );
};

const linkWithLocalProof = async () => {
  const opened: string[] = [];
  const outcome = await linkDesktopAccount({
    apiBaseUrl: "https://api.example.test",
    approval: "local-proof",
    onDesktopOpening: (desktopUrl) => {
      opened.push(desktopUrl);
    },
  });
  if (outcome.isErr()) {
    return panic("The local-proof attempt must settle to an outcome");
  }
  return { opened, outcome: outcome.value };
};

describe("approving a desktop challenge without a click", () => {
  // Each reply stands for a link crafted elsewhere: no app on this computer
  // holds its port secret, or the app holds a different challenge.
  const UNPROVEN = {
    "no app answers": () => {
      throw new TypeError("Failed to fetch");
    },
    "the app does not know the correlation": () =>
      Response.json(
        { message: "Desktop connection is unavailable" },
        { status: 401 },
      ),
    "another port secret signed the status": () =>
      signedStatus(PENDING, {
        ...SIGNED_BY_THE_LOCAL_APP,
        portSecret: "c".repeat(64),
      }),
    "the app signed another verifier": () =>
      signedStatus(PENDING, {
        ...SIGNED_BY_THE_LOCAL_APP,
        verifierHash: "c".repeat(64),
      }),
    "the app signed another device key": () =>
      signedStatus(PENDING, {
        ...SIGNED_BY_THE_LOCAL_APP,
        deviceJkt: "B".repeat(43),
      }),
    "the status is older than the skew window": () =>
      signedStatus(PENDING, { ...SIGNED_BY_THE_LOCAL_APP, skewSeconds: -31 }),
    "the status is ahead of the skew window": () =>
      signedStatus(PENDING, { ...SIGNED_BY_THE_LOCAL_APP, skewSeconds: 31 }),
    "the app no longer waits for it": () =>
      signedStatus(CONNECTED, SIGNED_BY_THE_LOCAL_APP),
  } as const satisfies Record<string, LoopbackReply>;

  test.each(Object.entries(UNPROVEN))(
    "%s: the challenge waits for an explicit approval and no grant is posted",
    async (_reason, reply) => {
      const network = scriptNetwork(reply);
      openChallenge();
      // happy-dom cannot navigate back from the `stella:` scheme an approval
      // opens, so whatever ran before, this attempt must not change it.
      const protocol = window.location.protocol;

      const { opened, outcome } = await linkWithLocalProof();

      expect(outcome).toEqual({ status: "approval-required" });
      expect(network.grants).toEqual([]);
      expect(opened).toEqual([]);
      expect(network.loopbackRequests).toEqual(["/v1/connection"]);
      expect(window.location.protocol).toBe(protocol);
      expect(hasDesktopAccountChallenge()).toBe(true);
    },
  );

  test("a fresh pending status the local app signed for the whole challenge approves it", async () => {
    const network = scriptNetwork((phase) =>
      signedStatus(
        phase === "before-grant" ? PENDING : CONNECTED,
        SIGNED_BY_THE_LOCAL_APP,
      ),
    );
    openChallenge();

    const { opened, outcome } = await linkWithLocalProof();

    expect(outcome.status).toBe("connected");
    expect(network.grants).toEqual([
      {
        correlationId: challenge.correlationId,
        verifierHash: challenge.verifierHash,
        deviceJkt: challenge.deviceJkt,
      },
    ]);
    expect(opened).toHaveLength(1);
    const desktopUrl = new URL(opened[0] ?? "");
    expect(`${desktopUrl.protocol}//${desktopUrl.host}`).toBe(
      "stella://account",
    );
    expect(desktopUrl.searchParams.get("correlationId")).toBe(
      challenge.correlationId,
    );
    expect(window.location.href).toBe(desktopUrl.href);
    expect(network.loopbackRequests).toEqual([
      "/v1/connection",
      "/v1/connection",
    ]);
    expect(hasDesktopAccountChallenge()).toBe(false);
  });
});

describe("a link the app ends", () => {
  // Every reason the page names with its own next step, and the update the
  // app needs; only an unclassified failure stays an error.
  const NAMED = [
    ["account_conflict", { status: "refused", reason: "account_conflict" }],
    ["switch_declined", { status: "refused", reason: "switch_declined" }],
    ["declined", { status: "refused", reason: "declined" }],
    ["update_required", { status: "update-required" }],
  ] as const;

  test.each(NAMED)(
    "%s reaches the page as its own outcome",
    async (reason, expected) => {
      scriptNetwork((phase) =>
        signedStatus(
          phase === "before-grant" ? PENDING : { status: "failed", reason },
          SIGNED_BY_THE_LOCAL_APP,
        ),
      );
      openChallenge();

      const { outcome } = await linkWithLocalProof();

      expect(outcome).toEqual(expected);
    },
  );

  test("an unclassified failure stays an error", async () => {
    scriptNetwork((phase) =>
      signedStatus(
        phase === "before-grant"
          ? PENDING
          : { status: "failed", reason: "unavailable" },
        SIGNED_BY_THE_LOCAL_APP,
      ),
    );
    openChallenge();

    const outcome = await linkDesktopAccount({
      apiBaseUrl: "https://api.example.test",
      approval: "local-proof",
      onDesktopOpening: () => {},
    });

    expect(outcome.isErr()).toBe(true);
  });
});

describe("an installed desktop from before failure reasons", () => {
  const BEFORE_REASONS = String(DESKTOP_LINK_FAILURE_REASON_PROTOCOL - 1);

  test("still connects normally", async () => {
    const network = scriptNetwork((phase) =>
      signedStatus(
        phase === "before-grant" ? PENDING : CONNECTED,
        SIGNED_BY_THE_LOCAL_APP,
      ),
    );
    openChallenge(BEFORE_REASONS);

    const { opened, outcome } = await linkWithLocalProof();

    expect(outcome.status).toBe("connected");
    expect(network.grants).toHaveLength(1);
    expect(opened).toHaveLength(1);
  });

  test("reports its bare failure as an error and offers no switch", async () => {
    scriptNetwork((phase) =>
      phase === "before-grant"
        ? signedStatus(PENDING, SIGNED_BY_THE_LOCAL_APP)
        : signedReply({
            payload: { status: "failed" },
            line: "failed",
            signature: SIGNED_BY_THE_LOCAL_APP,
          }),
    );
    openChallenge(BEFORE_REASONS);

    const outcome = await linkDesktopAccount({
      apiBaseUrl: "https://api.example.test",
      approval: "local-proof",
      onDesktopOpening: () => {},
    });

    // The signed bare failure is a valid answer from that desktop, not an
    // incompatible one; it carries no reason, so no refusal or switch.
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error).not.toBeInstanceOf(DesktopBridgeIncompatibleError);
    }
  });
});
