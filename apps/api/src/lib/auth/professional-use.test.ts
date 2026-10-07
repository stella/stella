import { describe, expect, test } from "bun:test";

import { AGENT_IDENTITY_CREATE_USER_PATH } from "@/api/lib/auth/agent-auth-user";
import { requireUserCreationOrigin } from "@/api/lib/auth/professional-use";
import { REVIEW_ACCOUNT_CREATE_USER_PATH } from "@/api/lib/auth/review-account-plugin";

describe("account creation origin", () => {
  test.each([
    ["/sign-in/email-otp", "interactive_registration"],
    ["/callback/google", "interactive_registration"],
    ["/callback/microsoft", "interactive_registration"],
    ["/callback/:id", "interactive_registration"],
    ["/sign-up/email", "interactive_registration"],
    ["/sign-in/social", "identity_token_sign_in"],
    [AGENT_IDENTITY_CREATE_USER_PATH, "agent_provisioning"],
    [REVIEW_ACCOUNT_CREATE_USER_PATH, "operator_command"],
  ] as const)("an account created through %s has origin %s", (path, origin) => {
    expect(requireUserCreationOrigin(path)).toBe(origin);
  });

  // A creation path nobody classified must not record, or skip, an
  // acceptance by default: the user hook refuses the creation.
  test.each([
    ["/admin/create-user"],
    ["/sign-in/anonymous"],
    ["/callback"],
    ["virtual:"],
    [undefined],
  ] as const)("refuses an account created through %p", (path) => {
    expect(() => requireUserCreationOrigin(path)).toThrow(
      "has no professional-use origin",
    );
  });
});
