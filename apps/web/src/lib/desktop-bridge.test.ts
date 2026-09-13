import { panic, Result } from "better-result";
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  DesktopAccountConflictError,
  DesktopBridgeUnavailableError,
  completeDesktopAccountLink,
  desktopAccountLinkRequest,
  isDesktopAccountLink,
  resolveDesktopAccountLink,
  retryAmbiguousAccountLink,
  revokeDesktopCredential,
} from "@/lib/desktop-bridge";
import type { AccountLinkPostError } from "@/lib/desktop-bridge";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const setFetch = (
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
) => {
  const fetchMock = mock(handler);
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  return fetchMock;
};

describe("desktop credential revocation", () => {
  const options = {
    apiBaseUrl: "https://api.example.com",
    key: "stella_dr_fixture",
  };

  test("returns a transport failure instead of throwing", async () => {
    const transportError = new TypeError("network down");
    setFetch(async () => {
      throw transportError;
    });
    const outcome = await revokeDesktopCredential(options);
    if (outcome.status !== "error") {
      panic("Expected revocation to report the transport failure");
    }
    expect(outcome.error).toBe(transportError);
  });

  test("treats success and an already unusable credential as revoked", async () => {
    for (const status of [200, 401]) {
      setFetch(async () => new Response(null, { status }));
      expect((await revokeDesktopCredential(options)).isOk()).toBe(true);
    }
  });

  test("reports any other rejection", async () => {
    setFetch(async () => new Response(null, { status: 500 }));
    expect((await revokeDesktopCredential(options)).isErr()).toBe(true);
  });
});

describe("desktop account-link hash", () => {
  test("accepts only the exact nonsecret account-link marker", () => {
    expect(isDesktopAccountLink("#desktop-account")).toBe(true);
    expect(isDesktopAccountLink("#desktop-account=secret")).toBe(false);
    expect(isDesktopAccountLink("#desktop-registry=nonce")).toBe(false);
  });
});

test("a refused account link revokes its newly minted credential", async () => {
  const linkError = new Error("bridge refused link");
  const revoked: string[] = [];
  const outcome = await completeDesktopAccountLink({
    apiBaseUrl: "https://api.example.com",
    grant: {
      account: {
        email: "lawyer@example.com",
        name: null,
        verifiedAt: "2026-09-12T20:00:00.000Z",
      },
      expiresAt: "2026-09-19T20:00:00.000Z",
      key: "stella_dr_fixture",
    },
    postLink: async () => Result.err({ type: "rejected", cause: linkError }),
    revoke: async (key) => {
      revoked.push(key);
      return Result.ok(undefined);
    },
  });

  if (outcome.status !== "error") {
    panic("Expected account link to fail");
  }
  expect(outcome.error).toBe(linkError);
  expect(revoked).toEqual(["stella_dr_fixture"]);
});

test("a cleanup failure reports both failures with the link error as cause", async () => {
  const linkError = new Error("bridge refused link");
  const cleanupError = new Error("revoke failed");
  const outcome = await completeDesktopAccountLink({
    apiBaseUrl: "https://api.example.com",
    grant: {
      account: {
        email: "lawyer@example.com",
        name: null,
        verifiedAt: "2026-09-12T20:00:00.000Z",
      },
      expiresAt: "2026-09-19T20:00:00.000Z",
      key: "stella_dr_fixture",
    },
    postLink: async () => Result.err({ type: "rejected", cause: linkError }),
    revoke: async () => Result.err(cleanupError),
  });

  if (outcome.status !== "error") {
    panic("Expected account link and cleanup to fail");
  }
  expect(outcome.error).toEqual(
    new AggregateError(
      [linkError, cleanupError],
      "Desktop account link failed and credential cleanup failed",
      { cause: linkError },
    ),
  );
});

test("the one account-link request carries only the server-minted credential", () => {
  const account = {
    email: "lawyer@example.com",
    name: "Example Lawyer",
    verifiedAt: "2026-09-12T20:00:00.000Z",
  };
  expect(
    desktopAccountLinkRequest("https://api.example.com", {
      account,
      expiresAt: "2026-09-19T20:00:00.000Z",
      key: "stella_dr_fixture",
    }),
  ).toEqual({
    apiBaseUrl: "https://api.example.com",
    credential: {
      expiresAt: "2026-09-19T20:00:00.000Z",
      key: "stella_dr_fixture",
    },
  });
});

test("an ambiguous link retries the identical credential and accepts its acknowledgement", async () => {
  const request = desktopAccountLinkRequest("https://api.example.com", {
    account: { email: "lawyer@example.com", name: null, verifiedAt: "now" },
    expiresAt: "later",
    key: "stella_dr_fixture",
  });
  const received: (typeof request)[] = [];
  const outcome = await retryAmbiguousAccountLink(request, async (body) => {
    received.push(body);
    return received.length === 1
      ? Result.err({
          type: "ambiguous",
          cause: new DesktopBridgeUnavailableError(),
        } satisfies AccountLinkPostError)
      : Result.ok(undefined);
  });

  expect(outcome.status).toBe("ok");
  expect(received).toEqual([request, request]);
});

test("a rejection after an ambiguous attempt never revokes a possibly committed credential", async () => {
  let attempts = 0;
  let revocations = 0;
  const outcome = await completeDesktopAccountLink({
    apiBaseUrl: "https://api.example.com",
    grant: {
      account: { email: "lawyer@example.com", name: null, verifiedAt: "now" },
      expiresAt: "later",
      key: "stella_dr_fixture",
    },
    postLink: async (request) =>
      await retryAmbiguousAccountLink(request, async () => {
        attempts += 1;
        return Result.err(
          attempts === 1
            ? ({
                type: "ambiguous",
                cause: new Error("timeout"),
              } satisfies AccountLinkPostError)
            : ({
                type: "rejected",
                cause: new Error("conflict"),
              } satisfies AccountLinkPostError),
        );
      }),
    revoke: async () => {
      revocations += 1;
      return Result.ok(undefined);
    },
  });

  expect(outcome.status).toBe("error");
  if (outcome.status !== "error") {
    panic("Expected the response-loss retry to remain ambiguous");
  }
  expect(outcome.error).toEqual(new Error("conflict"));
  expect(attempts).toBe(2);
  expect(revocations).toBe(0);
});

test("repeated transport ambiguity preserves the possibly committed credential", async () => {
  let attempts = 0;
  let revocations = 0;
  const outcome = await completeDesktopAccountLink({
    apiBaseUrl: "https://api.example.com",
    grant: {
      account: { email: "lawyer@example.com", name: null, verifiedAt: "now" },
      expiresAt: "later",
      key: "stella_dr_fixture",
    },
    postLink: async (request) =>
      await retryAmbiguousAccountLink(request, async () => {
        attempts += 1;
        return Result.err({
          type: "ambiguous",
          cause: new Error("timeout"),
        } satisfies AccountLinkPostError);
      }),
    revoke: async () => {
      revocations += 1;
      return Result.ok(undefined);
    },
  });

  expect(outcome.status).toBe("error");
  expect(attempts).toBe(2);
  expect(revocations).toBe(0);
});

test("repeating a link for the same account neither mints nor writes", async () => {
  const calls: string[] = [];
  const outcome = await resolveDesktopAccountLink({
    apiBaseUrl: "https://api.example.com",
    browserAccount: {
      identity: { userId: "user-1", organizationId: "org-1" },
      email: "updated@example.com",
      name: "Current browser profile",
      verifiedAt: "2026-09-12T20:00:00.000Z",
    },
    desktopAccount: {
      status: "connected",
      identity: { userId: "user-1", organizationId: "org-1" },
      account: {
        email: "lawyer@example.com",
        name: "Persisted desktop profile",
        verifiedAt: "2026-09-11T20:00:00.000Z",
      },
      expiresAt: "2026-09-19T20:00:00.000Z",
    },
    mintGrant: async () => {
      calls.push("mint");
      throw new Error("must not mint");
    },
    postLink: async () => {
      calls.push("write");
      return Result.ok(undefined);
    },
    revoke: async () => {
      calls.push("revoke");
      return Result.ok(undefined);
    },
  });

  if (outcome.status !== "ok") {
    panic("Expected repeated account link to succeed");
  }
  expect(outcome.value).toBe("lawyer@example.com");
  expect(calls).toEqual([]);
});

test("matching email in another account must be disconnected before replacement", async () => {
  const browserIdentities = [
    { userId: "user-1", organizationId: "org-2" },
    { userId: "user-2", organizationId: "org-1" },
    { userId: "user-2", organizationId: "org-2" },
  ];
  for (const identity of browserIdentities) {
    const outcome = await resolveDesktopAccountLink({
      apiBaseUrl: "https://api.example.com",
      browserAccount: {
        identity,
        email: "existing@example.com",
        name: "Existing Account",
        verifiedAt: "2026-09-12T20:00:00.000Z",
      },
      desktopAccount: {
        status: "connected",
        identity: { userId: "user-1", organizationId: "org-1" },
        account: {
          email: "existing@example.com",
          name: null,
          verifiedAt: "2026-09-11T20:00:00.000Z",
        },
        expiresAt: "2026-09-19T20:00:00.000Z",
      },
      mintGrant: async () => {
        throw new Error("must not mint");
      },
      postLink: async () => Result.ok(undefined),
      revoke: async () => Result.ok(undefined),
    });

    if (outcome.status !== "error") {
      panic("Expected different account link to fail");
    }
    expect(outcome.error).toBeInstanceOf(DesktopAccountConflictError);
  }
});
