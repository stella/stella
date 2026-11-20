import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { describe, expect, test } from "bun:test";

import type { EmailDeliveryFailureReason } from "@stll/api-contract/email-delivery";

import { createEmailDeliveryStatusPlugin } from "@/api/lib/auth/email-delivery-status";
import {
  type NormalizedEmail,
  normalizeEmail,
} from "@/api/lib/email/normalized-email";

const baseURL = "http://localhost:3001";

type Fixture = {
  failures?: Map<string, EmailDeliveryFailureReason>;
  readFails?: boolean;
  existingAccount?: string;
};

const createAuth = async ({
  failures = new Map(),
  readFails = false,
  existingAccount,
}: Fixture = {}) => {
  const codes = new Map<string, string>();
  const reads: NormalizedEmail[] = [];
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
        sendVerificationOTP: async ({ email, otp }) => {
          codes.set(email, otp);
        },
      }),
      createEmailDeliveryStatusPlugin(createAuthMiddleware, {
        readFailure: async (email) => {
          reads.push(email);
          if (readFails) {
            throw new Error("database unavailable");
          }
          return failures.get(email);
        },
        forgetFailure: async (email) => {
          failures.delete(email);
        },
      }),
    ],
  });
  if (existingAccount !== undefined) {
    const context = await auth.$context;
    await context.internalAdapter.createUser(
      { email: existingAccount, name: "Account", emailVerified: true },
      { method: "admin" },
    );
  }
  const requestCode = async (email: string) => {
    const response = await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      asResponse: true,
    });
    return { status: response.status, body: await response.json() };
  };
  return { auth, codes, failures, reads, requestCode };
};

describe("email delivery status on a code request", () => {
  test("names the recorded failure for the requested address, whatever its case", async () => {
    const { requestCode, reads } = await createAuth({
      failures: new Map([["new.member@example.test", "tls_required"]]),
    });

    expect(await requestCode("New.Member@Example.test")).toEqual({
      status: 200,
      body: {
        success: true,
        emailDelivery: { type: "failed", reason: "tls_required" },
      },
    });
    expect(reads).toEqual([normalizeEmail("new.member@example.test")]);
  });

  test("says no failure is recorded, the same for a new and an existing account", async () => {
    const fresh = await createAuth();
    const existing = await createAuth({
      existingAccount: "member@example.test",
    });

    const expected = {
      status: 200,
      body: { success: true, emailDelivery: { type: "none_recorded" } },
    };
    expect(await fresh.requestCode("member@example.test")).toEqual(expected);
    expect(await existing.requestCode("member@example.test")).toEqual(expected);
  });

  test("answers an unknown status when the failure cannot be read", async () => {
    const { requestCode } = await createAuth({ readFails: true });

    expect(await requestCode("member@example.test")).toEqual({
      status: 200,
      body: { success: true, emailDelivery: { type: "unknown" } },
    });
  });

  test("a refused code request is left as it was", async () => {
    const { requestCode, reads } = await createAuth();

    const refused = await requestCode("not an address");
    expect(refused.status).toBe(400);
    expect(refused.body).not.toHaveProperty("emailDelivery");
    expect(reads).toEqual([]);
  });
});

describe("email delivery failure after a code sign-in", () => {
  test("a code sign-in proves the mail arrived and drops the failure", async () => {
    const email = "member@example.test";
    const { auth, codes, failures, requestCode } = await createAuth({
      failures: new Map([[email, "mailbox_unavailable"]]),
    });
    await requestCode(email);
    const otp = codes.get(email);
    expect(otp).toBeString();

    const response = await auth.api.signInEmailOTP({
      body: { email, otp: otp ?? "" },
      asResponse: true,
    });

    expect(response.status).toBe(200);
    expect(failures.has(email)).toBe(false);
  });

  test("a wrong code keeps the failure", async () => {
    const email = "member@example.test";
    const { auth, failures, requestCode } = await createAuth({
      failures: new Map([[email, "mailbox_unavailable"]]),
    });
    await requestCode(email);

    const response = await auth.api.signInEmailOTP({
      body: { email, otp: "000000" },
      asResponse: true,
    });

    expect(response.status).toBe(400);
    expect(failures.get(email)).toBe("mailbox_unavailable");
  });
});
