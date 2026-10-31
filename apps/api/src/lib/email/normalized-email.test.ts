import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP } from "better-auth/plugins";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  emailAddressSchema,
  normalizeEmail,
} from "@/api/lib/email/normalized-email";

// Characters whose case mapping differs between folds or runtimes: Turkish
// dotted and dotless i, the long s, the Kelvin sign, Greek sigma in its
// final form, and the sharp s with its capital.
const ADDRESS_CHARACTERS = [
  "a",
  "A",
  "z",
  "Z",
  "i",
  "I",
  "\u0130",
  "\u0131",
  "s",
  "S",
  "\u017f",
  "k",
  "K",
  "\u212a",
  "\u03c3",
  "\u03a3",
  "\u03c2",
  "\u00df",
  "\u1e9e",
  "\u00e9",
  "\u00c9",
  "0",
  "9",
  ".",
  "_",
  "+",
  "-",
] as const;
const WHITESPACE = [
  " ",
  "\t",
  "\n",
  "\u00a0",
  "\u2003",
  "\u3000",
  "\ufeff",
] as const;

const addressPart = fc.string({
  unit: fc.constantFrom(...ADDRESS_CHARACTERS),
  minLength: 1,
  maxLength: 10,
});
const addressArbitrary = fc
  .tuple(addressPart, addressPart, fc.constantFrom("com", "CZ", "Test"))
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);
// Addresses Better Auth's validator can accept once lowercased, including a
// Kelvin sign that lowercases to an ASCII k.
const acceptableArbitrary = fc
  .tuple(
    fc.string({
      unit: fc.constantFrom("a", "B", "k", "K", "\u212a", "0"),
      minLength: 1,
      maxLength: 8,
    }),
    fc.constantFrom("example", "EXAMPLE", "Stella"),
  )
  .map(([local, domain]) => `${local}@${domain}.Test`);
const paddingArbitrary = fc.string({
  unit: fc.constantFrom(...WHITESPACE),
  maxLength: 3,
});
const caseVariant = (address: string, flips: readonly boolean[]) =>
  Array.from(address)
    .map((character, index) =>
      flips[index % Math.max(flips.length, 1)] === true
        ? character.toUpperCase()
        : character.toLowerCase(),
    )
    .join("");

describe("normalizeEmail", () => {
  test.each([
    ["mixed case", "Jan.Novak@Example.COM", "jan.novak@example.com"],
    ["surrounding spaces", "  jan@example.com  ", "jan@example.com"],
    ["tabs and newlines", "\tjan@example.com\n", "jan@example.com"],
    [
      "no-break space and BOM",
      "\u00a0\ufeffjan@example.com\u3000",
      "jan@example.com",
    ],
    [
      "capital I ignores a Turkish locale",
      "IGOR@EXAMPLE.COM",
      "igor@example.com",
    ],
    [
      "dotted capital I keeps its dot",
      "\u0130lker@example.com",
      "i\u0307lker@example.com",
    ],
    [
      "dotless i is already lowercase",
      "\u0131lker@example.com",
      "\u0131lker@example.com",
    ],
    [
      "long s is already lowercase",
      "\u017fam@example.com",
      "\u017fam@example.com",
    ],
    ["Kelvin sign folds to k", "\u212aate@example.com", "kate@example.com"],
  ])("%s", (_name, raw, expected) => {
    expect(String(normalizeEmail(raw))).toBe(expected);
  });

  test("keeps dotless i and long s distinct from i and s", () => {
    expect(normalizeEmail("\u0131@example.com")).not.toBe(
      normalizeEmail("i@example.com"),
    );
    expect(normalizeEmail("\u017f@example.com")).not.toBe(
      normalizeEmail("s@example.com"),
    );
    // The Turkish locale fold would have merged capital I into dotless i.
    expect("I".toLocaleLowerCase("tr")).toBe("\u0131");
    expect(String(normalizeEmail("I@example.com"))).toBe("i@example.com");
  });

  test("normalization is idempotent and leaves no surrounding whitespace", () => {
    assertProperty(
      "normalization is idempotent and leaves no surrounding whitespace",
      fc.property(
        paddingArbitrary,
        fc.oneof(addressArbitrary, fc.string({ unit: "grapheme" })),
        paddingArbitrary,
        (before, address, after) => {
          const key = normalizeEmail(`${before}${address}${after}`);
          expect(normalizeEmail(key)).toBe(key);
          expect(key.trim()).toBe(key);
          expect(key).toBe(normalizeEmail(address));
        },
      ),
      { numRuns: 300 },
    );
  });

  test("the configuration schema normalizes before it validates", () => {
    expect(v.parse(emailAddressSchema, "  Jan@Example.COM ")).toBe(
      "jan@example.com",
    );
    expect(v.safeParse(emailAddressSchema, "not an address").success).toBe(
      false,
    );
  });
});

const createAuth = () => {
  const sent: string[] = [];
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    rateLimit: { enabled: false },
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    plugins: [
      emailOTP({
        storeOTP: "plain",
        sendVerificationOTP: async ({ email }) => {
          sent.push(email);
        },
      }),
    ],
  });
  const requestCode = async (email: string) =>
    await auth.handler(
      new Request(
        "http://localhost:3001/api/auth/email-otp/send-verification-otp",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, type: "sign-in" }),
        },
      ),
    );
  return { auth, sent, requestCode };
};

describe("Better Auth parity", () => {
  test("Better Auth keys every address it accepts by the normalized address", async () => {
    const { auth, sent, requestCode } = createAuth();
    const context = await auth.$context;
    const outcomes = { accepted: 0, refusedPadded: 0 };
    await assertProperty(
      "Better Auth keys every address it accepts by the normalized address",
      fc.asyncProperty(
        paddingArbitrary,
        fc.oneof(acceptableArbitrary, addressArbitrary),
        paddingArbitrary,
        async (before, address, after) => {
          const raw = `${before}${address}${after}`;
          sent.length = 0;
          const response = await requestCode(raw);
          if (raw !== raw.trim()) {
            // Surrounding whitespace never reaches an account, so the trim
            // only ever applies to gates that run before this validator.
            expect(response.status).toBe(400);
            outcomes.refusedPadded += 1;
            return;
          }
          if (response.status !== 200) {
            expect(response.status).toBe(400);
            return;
          }
          const key = normalizeEmail(raw);
          expect(sent).toEqual([key]);
          // Accepted addresses fold to ASCII; database parity separately
          // verifies case mapping under the configured supported collation.
          expect(key).toMatch(/^[\u0021-\u007e]+$/u);
          const verification =
            await context.internalAdapter.findVerificationValue(
              `sign-in-otp-${key}`,
            );
          expect(verification).not.toBeNull();
          outcomes.accepted += 1;
        },
      ),
      { numRuns: 200 },
    );
    expect(outcomes.accepted).toBeGreaterThan(0);
    expect(outcomes.refusedPadded).toBeGreaterThan(0);
  });

  test("Better Auth stores and finds an account by the normalized address", async () => {
    const { auth } = createAuth();
    const context = await auth.$context;
    await assertProperty(
      "Better Auth stores and finds an account by the normalized address",
      fc.asyncProperty(
        addressArbitrary,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        async (address, flips) => {
          const stored = await context.internalAdapter.findUserByEmail(address);
          const user =
            stored?.user ??
            (await context.internalAdapter.createUser(
              {
                email: address,
                name: "Account",
                emailVerified: true,
              },
              { method: "admin" },
            ));
          expect(user.email).toBe(normalizeEmail(address));
          const variant = caseVariant(address, flips);
          const found = await context.internalAdapter.findUserByEmail(variant);
          expect(found?.user.id === user.id).toBe(
            normalizeEmail(variant) === normalizeEmail(address),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
