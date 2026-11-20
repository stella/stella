import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP } from "better-auth/plugins";
import { describe, expect, test } from "bun:test";

import { SIGN_IN_ATTEMPT_HEADER } from "@stll/api-contract/email-delivery";

import { EMAIL_OTP_LIFETIME_SECONDS } from "@/api/lib/auth/email-otp-reset-confirmation";
import {
  createSignInCodeDeliveryPlugin,
  markSignInCodeFailure,
  rememberSignInCodeSend,
  type SignInCodeAudience,
} from "@/api/lib/auth/sign-in-code-delivery";
import {
  createSignInCodeDeliveryStore,
  SIGN_IN_CODE_DELIVERY_TTL_SECONDS,
  type SignInCodeDeliveryStore,
} from "@/api/lib/auth/sign-in-code-delivery-store";

const baseURL = "http://localhost:3001";

const newAttempt = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

// The Valkey store's contract over plain maps: a message names the attempt
// that sent it, and a failure is kept per attempt.
const memoryStore = () => {
  const senders = new Map<string, string>();
  const failures = new Map<string, string>();
  const store: SignInCodeDeliveryStore = {
    rememberSend: async ({ attemptKey, providerMessageId }) => {
      senders.set(providerMessageId, attemptKey);
    },
    markFailed: async ({ providerMessageId, reason }) => {
      const attemptKey = senders.get(providerMessageId);
      if (attemptKey !== undefined) {
        failures.set(attemptKey, reason);
      }
    },
    readFailure: async (attemptKey) => failures.get(attemptKey),
  };
  return { store, senders, failures };
};

const createAuth = ({
  audience = "any_address",
}: { audience?: SignInCodeAudience } = {}) => {
  const { store, senders, failures } = memoryStore();
  const sent: { email: string; providerMessageId: string }[] = [];
  const auth = betterAuth({
    baseURL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    logger: { disabled: true },
    database: memoryAdapter({
      user: [],
      account: [],
      session: [],
      verification: [],
    }),
    plugins: [
      emailOTP({
        sendVerificationOTP: async ({ email }, ctx) => {
          const providerMessageId = `provider-message-${sent.length + 1}`;
          sent.push({ email, providerMessageId });
          await rememberSignInCodeSend({
            store,
            headers: ctx?.headers,
            outcome: { type: "accepted", providerMessageId },
            audience,
          });
        },
      }),
      createSignInCodeDeliveryPlugin(store),
    ],
  });
  const requestCode = async (email: string, attempt?: string) => {
    const response = await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers: new Headers(
        attempt === undefined ? {} : { [SIGN_IN_ATTEMPT_HEADER]: attempt },
      ),
      asResponse: true,
    });
    return { status: response.status, body: await response.text() };
  };
  const poll = async (body: { attempt: string }) => {
    const response = await auth.api.readSignInCodeDelivery({
      body,
      asResponse: true,
    });
    return {
      status: response.status,
      cacheControl: response.headers.get("Cache-Control"),
      body: await response.text(),
    };
  };
  const bounce = markSignInCodeFailure(store);
  const lastMessage = () => sent.at(-1)?.providerMessageId ?? "";
  return { requestCode, poll, bounce, lastMessage, senders, failures };
};

const NONE = JSON.stringify({ status: "none" });

describe("sign-in code delivery follow-up", () => {
  test("an address with an older bounce shows nothing until this attempt's own mail bounces", async () => {
    const { requestCode, poll, bounce, lastMessage } = createAuth();
    // Mail of another kind to the same address bounced earlier; no attempt
    // sent it, so nothing records it.
    await bounce("invitation-message", "mailbox_missing");
    const earlier = newAttempt();
    await requestCode("member@example.test", earlier);
    await bounce(lastMessage(), "mailbox_missing");

    const attempt = newAttempt();
    await requestCode("member@example.test", attempt);
    expect((await poll({ attempt })).body).toBe(NONE);

    await bounce(lastMessage(), "mailbox_missing");
    expect(JSON.parse((await poll({ attempt })).body)).toEqual({
      status: "failed",
      reason: "mailbox_missing",
    });
  });

  test("a suppressed send reads like no report at all", async () => {
    const { requestCode, poll, bounce, lastMessage } = createAuth();
    const attempt = newAttempt();
    await requestCode("member@example.test", attempt);
    await bounce(lastMessage(), "suppressed");

    expect(await poll({ attempt })).toEqual(
      await poll({ attempt: newAttempt() }),
    );
    expect((await poll({ attempt })).body).toBe(NONE);
  });

  test("a code sent only because the address has an account is never reported on", async () => {
    const { requestCode, poll, bounce, lastMessage, senders } = createAuth({
      audience: "accounts_only",
    });
    const attempt = newAttempt();
    await requestCode("member@example.test", attempt);
    await bounce(lastMessage(), "mailbox_missing");

    expect(senders.size).toBe(0);
    expect((await poll({ attempt })).body).toBe(NONE);
  });

  test("unknown and malformed attempts answer exactly like a pending one", async () => {
    const { requestCode, poll } = createAuth();
    const attempt = newAttempt();
    await requestCode("member@example.test", attempt);
    const pending = await poll({ attempt });

    expect(pending).toEqual({
      status: 200,
      cacheControl: "private, no-store",
      body: NONE,
    });
    for (const body of [
      { attempt: newAttempt() },
      { attempt: "short" },
      { attempt: `${attempt}=` },
    ]) {
      expect(await poll(body)).toEqual(pending);
    }
  });

  test("the code request answers the same with or without an attempt", async () => {
    const { requestCode, senders } = createAuth();
    const withAttempt = await requestCode("member@example.test", newAttempt());
    const without = await requestCode("other@example.test");

    expect(withAttempt).toEqual(without);
    // Only the request that named an attempt is remembered, by its hash.
    expect([...senders.values()]).toHaveLength(1);
    expect([...senders.values()][0]).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("a failure names only the reason", async () => {
    const { requestCode, poll, bounce, lastMessage } = createAuth();
    const attempt = newAttempt();
    await requestCode("member@example.test", attempt);
    await bounce(lastMessage(), "tls_required");

    expect(Object.keys(JSON.parse((await poll({ attempt })).body))).toEqual([
      "status",
      "reason",
    ]);
  });
});

describe("sign-in code delivery store", () => {
  const fakeValkey = (replies: Map<string, unknown>) => {
    const calls: string[][] = [];
    const store = createSignInCodeDeliveryStore({
      ready: async () => ({
        send: async (command, args) => {
          calls.push([command, ...args]);
          return replies.get(command) ?? null;
        },
      }),
    });
    return { store, calls };
  };

  test("keeps a send no longer than the code lives, plus a short margin", async () => {
    expect(SIGN_IN_CODE_DELIVERY_TTL_SECONDS).toBeGreaterThan(
      EMAIL_OTP_LIFETIME_SECONDS,
    );
    expect(SIGN_IN_CODE_DELIVERY_TTL_SECONDS).toBeLessThanOrEqual(
      EMAIL_OTP_LIFETIME_SECONDS + 60,
    );
    const { store, calls } = fakeValkey(new Map());
    await store.rememberSend({
      attemptKey: "attempt-hash",
      providerMessageId: "provider-message",
    });

    expect(calls).toEqual([
      [
        "SET",
        "sign-in-code-delivery:{provider-message}:attempt",
        "attempt-hash",
        "EX",
        String(SIGN_IN_CODE_DELIVERY_TTL_SECONDS),
      ],
    ]);
  });

  test("a failure expires with the send it belongs to", async () => {
    const { store, calls } = fakeValkey(
      new Map([["EVAL", ["attempt-hash", 4200]]]),
    );
    await store.markFailed({
      providerMessageId: "provider-message",
      reason: "mailbox_missing",
    });

    expect(calls.at(-1)).toEqual([
      "SET",
      "sign-in-code-delivery:{attempt-hash}:failure",
      "mailbox_missing",
      "PX",
      "4200",
    ]);
  });

  test("a bounce of a message no attempt sent writes nothing", async () => {
    const { store, calls } = fakeValkey(new Map());
    await store.markFailed({
      providerMessageId: "invitation-message",
      reason: "mailbox_missing",
    });

    expect(calls.map(([command]) => command)).toEqual(["EVAL"]);
  });
});
