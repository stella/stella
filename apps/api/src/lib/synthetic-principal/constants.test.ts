import { expect, test } from "bun:test";

import { isSyntheticPrincipal, SYNTHETIC_PRINCIPAL } from "./constants";

test("absent email is not a synthetic identity", () => {
  for (const email of [undefined, null]) {
    expect(isSyntheticPrincipal({ email })).toBe(false);
    expect(
      isSyntheticPrincipal({ email, userId: SYNTHETIC_PRINCIPAL.user.id }),
    ).toBe(true);
    expect(
      isSyntheticPrincipal({
        email,
        organizationId: SYNTHETIC_PRINCIPAL.org.id,
      }),
    ).toBe(true);
  }
});

test("email identity uses the canonical normalized address", () => {
  expect(
    isSyntheticPrincipal({
      email: `  ${SYNTHETIC_PRINCIPAL.user.email.toUpperCase()}  `,
    }),
  ).toBe(true);
  expect(isSyntheticPrincipal({ email: "ordinary@example.test" })).toBe(false);
});
