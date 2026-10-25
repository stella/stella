import { expect, test } from "bun:test";

import { isSyntheticPrincipal, SYNTHETIC_PRINCIPAL } from "./constants";

test("absent email is not a synthetic identity", () => {
  for (const identity of [{}, { email: undefined }]) {
    expect(isSyntheticPrincipal(identity)).toBe(false);
    expect(
      isSyntheticPrincipal({
        ...identity,
        userId: SYNTHETIC_PRINCIPAL.user.id,
      }),
    ).toBe(true);
    expect(
      isSyntheticPrincipal({
        ...identity,
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
