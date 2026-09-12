import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  DesktopAccountConflictError,
  completeDesktopAccountLink,
  desktopAccountLinkRequest,
  isDesktopAccountLink,
  resolveDesktopAccountLink,
} from "@/lib/desktop-bridge";

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
    postLink: async () => {
      throw linkError;
    },
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
    postLink: async () => {
      throw linkError;
    },
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

test("repeating a link for the same account neither mints nor writes", async () => {
  const calls: string[] = [];
  const outcome = await resolveDesktopAccountLink({
    apiBaseUrl: "https://api.example.com",
    browserAccount: {
      email: "lawyer@example.com",
      name: "Current browser profile",
      verifiedAt: "2026-09-12T20:00:00.000Z",
    },
    desktopAccount: {
      status: "connected",
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

test("a different linked account must be disconnected before replacement", async () => {
  const outcome = await resolveDesktopAccountLink({
    apiBaseUrl: "https://api.example.com",
    browserAccount: {
      email: "new@example.com",
      name: null,
      verifiedAt: "2026-09-12T20:00:00.000Z",
    },
    desktopAccount: {
      status: "connected",
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
    postLink: async () => undefined,
    revoke: async () => Result.ok(undefined),
  });

  if (outcome.status !== "error") {
    panic("Expected different account link to fail");
  }
  expect(outcome.error).toBeInstanceOf(DesktopAccountConflictError);
});
