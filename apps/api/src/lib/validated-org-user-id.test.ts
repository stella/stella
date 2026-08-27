import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import { toSafeId } from "@/api/lib/branded-types";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// `user.id` and `member.user_id` are text columns holding whatever the auth
// provider mints. The default generator produces base62 text and a configured
// one may produce UUIDs, so both shapes are stored ids, not just accepted input.
const AUTH_GENERATED_ID = mintAuthProviderIdValue();
const UUID_ID = "0191d14d-9a63-7d2e-a021-06053e542c85";

const txReturning = (rows: { userId: string }[]) =>
  asTestRaw<Transaction>({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  });

const organizationId = toSafeId<"organization">(AUTH_GENERATED_ID);

describe("validateOrgUserId", () => {
  test.each([
    ["auth-generated", AUTH_GENERATED_ID],
    ["UUID", UUID_ID],
  ])("brands a confirmed member holding an %s id", async (_shape, userId) => {
    const validated = await validateOrgUserId(
      txReturning([{ userId }]),
      toSafeId<"user">(userId),
      organizationId,
    );

    expect(String(validated)).toBe(userId);
  });

  test("returns null when the user is not a member", async () => {
    const validated = await validateOrgUserId(
      txReturning([]),
      toSafeId<"user">(AUTH_GENERATED_ID),
      organizationId,
    );

    expect(validated).toBeNull();
  });
});
