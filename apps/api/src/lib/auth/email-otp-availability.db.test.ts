import { afterAll, expect, test } from "bun:test";

import { user } from "@/api/db/auth-schema";
import { env } from "@/api/env";
import { createAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { readDevOtp } from "@/api/lib/dev-otp-store";
import { isSelfhostFirstUserRequired } from "@/api/lib/selfhost-auth";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });

afterAll(releaseAgentAuthTestDb);

test("email OTP remains a sign-in method after bootstrap without any linked account", async () => {
  const db = await initAgentAuthTestDb();
  const id = mintAuthProviderId<"user">();
  const email = `${id}@sign-in.test`.toLowerCase();
  await db.insert(user).values({ id, name: "Jana Nováková", email });

  for (const localPassword of [false, true]) {
    for (const bootstrapToken of [undefined, "bootstrap-test-token"]) {
      testState.setConfig("SELFHOST_LOCAL_PASSWORD_AUTH", localPassword);
      testState.setConfig("SELFHOST_BOOTSTRAP_TOKEN", bootstrapToken);
      expect(await isSelfhostFirstUserRequired()).toBe(false);
      const auth = createAuth();
      const send = await auth.handler(
        new Request(getAuthEndpointUrl("email-otp/send-verification-otp"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, type: "sign-in" }),
        }),
      );
      expect(send.status).toBe(200);
      const otp = readDevOtp(email);
      expect(otp).toMatch(/^\d{6}$/u);
      const signIn = await auth.handler(
        new Request(getAuthEndpointUrl("sign-in/email-otp"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, otp }),
        }),
      );
      expect(signIn.status).toBe(200);
      expect(await signIn.json()).toMatchObject({
        token: expect.any(String),
        user: { id, email },
      });
    }
  }
});
