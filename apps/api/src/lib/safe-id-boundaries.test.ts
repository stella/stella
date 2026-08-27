import { describe, expect, test } from "bun:test";

import { AUTH_DATABASE_ID_OPTIONS } from "@/api/lib/auth-adapter-options";
import {
  AUTH_PROVIDER_ID_PATTERN,
  parseAuthProviderId,
} from "@/api/lib/safe-id-boundaries";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";

const UUID_ID = "0191d14d-9a63-7d2e-a021-06053e542c85";
const GENERATOR_SAMPLES = 500;

describe("auth-provider id pattern", () => {
  test("the auth provider runs its default id generator", () => {
    // The fixture generator in `tests/helpers/auth-provider-id.ts` mirrors the
    // default. Configuring a generator here without updating that helper and
    // this pattern would let fixtures drift from stored ids again.
    expect("generateId" in AUTH_DATABASE_ID_OPTIONS).toBe(false);
  });

  test("accepts every id the default generator mints", () => {
    for (let index = 0; index < GENERATOR_SAMPLES; index += 1) {
      const id = mintAuthProviderIdValue();
      expect(AUTH_PROVIDER_ID_PATTERN.test(id), id).toBe(true);
    }
  });

  test("accepts UUID ids, which a configured generator may produce", () => {
    expect(AUTH_PROVIDER_ID_PATTERN.test(UUID_ID)).toBe(true);
  });

  test("rejects separators that could smuggle a second identifier", () => {
    expect(AUTH_PROVIDER_ID_PATTERN.test("not/an/id")).toBe(false);
    expect(AUTH_PROVIDER_ID_PATTERN.test("")).toBe(false);
  });
});

describe("parseAuthProviderId", () => {
  test("brands a generated organization id", () => {
    const id = mintAuthProviderIdValue();
    expect(String(parseAuthProviderId<"organization">(id))).toBe(id);
  });

  test("brands a UUID user id", () => {
    expect(String(parseAuthProviderId<"user">(UUID_ID))).toBe(UUID_ID);
  });

  test("rejects malformed provider metadata before database access", () => {
    expect(parseAuthProviderId<"organization">("not/an/organization/id")).toBe(
      null,
    );
  });
});
