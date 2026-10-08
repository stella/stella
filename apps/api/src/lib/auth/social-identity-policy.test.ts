import type {
  GoogleProfile,
  MicrosoftEntraIDProfile,
} from "@better-auth/core/social-providers";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, test } from "bun:test";

import {
  createMicrosoftProfileMapper,
  createSocialIdentityValidation,
  isVerifiedMicrosoftIdentity,
  SOCIAL_ACCOUNT_LINKING_OPTIONS,
} from "@/api/lib/auth/social-identity-policy";
import {
  logger,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import type { LogRecord } from "@/api/lib/observability/logger";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const tenantId = "00000000-0000-4000-8000-000000000001";
const email = "account@example.test";
const profile = {
  tid: tenantId,
  iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  email,
};

describe("social identity policy", () => {
  test("requires a configured tenant and verified email", () => {
    for (const verified of [true, false, undefined, "true", 1]) {
      expect(
        isVerifiedMicrosoftIdentity({
          profile: { ...profile, xms_edov: verified },
          email,
          tenantId,
        }),
      ).toBe(verified === true);
    }
    expect(
      isVerifiedMicrosoftIdentity({
        profile: { ...profile, email_verified: true },
        email,
        tenantId,
      }),
    ).toBe(true);
    expect(
      isVerifiedMicrosoftIdentity({
        profile: { ...profile, verified_primary_email: [email] },
        email,
        tenantId,
      }),
    ).toBe(true);
    expect(
      isVerifiedMicrosoftIdentity({
        profile: { ...profile, xms_edov: true, email_verified: false },
        email,
        tenantId,
      }),
    ).toBe(false);
    expect(
      isVerifiedMicrosoftIdentity({
        profile: { ...profile, xms_edov: true },
        email,
        tenantId: undefined,
      }),
    ).toBe(false);
    expect(
      isVerifiedMicrosoftIdentity({ profile: undefined, email, tenantId }),
    ).toBe(false);
    expect(
      isVerifiedMicrosoftIdentity({
        profile: { ...profile, xms_edov: true, iss: undefined },
        email,
        tenantId,
      }),
    ).toBe(false);
    expect(
      isVerifiedMicrosoftIdentity({
        profile: { ...profile, xms_edov: true },
        email,
        tenantId: "00000000-0000-4000-8000-000000000002",
      }),
    ).toBe(false);
    expect(
      isVerifiedMicrosoftIdentity({
        profile: { ...profile, xms_edov: true },
        email: "other@example.test",
        tenantId,
      }),
    ).toBe(false);
  });

  test("respects each configured Microsoft account class", () => {
    const consumer = "9188040d-6c67-4c5b-b112-36a304b66dad";
    for (const tenant of [tenantId, consumer]) {
      for (const configured of [
        "common",
        "organizations",
        "consumers",
        tenantId,
      ]) {
        expect(
          isVerifiedMicrosoftIdentity({
            profile: {
              ...profile,
              tid: tenant,
              iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
              xms_edov: true,
            },
            email,
            tenantId: configured,
          }),
        ).toBe(
          configured === "common" ||
            (configured === "organizations" && tenant !== consumer) ||
            (configured === "consumers" && tenant === consumer) ||
            configured === tenant,
        );
      }
    }
  });

  test.each([false, true])(
    "applies Microsoft claim mode: %s",
    async (required) => {
      for (const verified of [false, true]) {
        const warnings: LogRecord[] = [];
        setLogSinkForTesting((record) => {
          warnings.push(record);
        });
        try {
          const auth = betterAuth({
            baseURL: "http://localhost:3001",
            secret: "test-secret-that-is-long-enough-for-better-auth",
            database: memoryAdapter({
              user: [],
              session: [],
              account: [],
              verification: [],
            }),
            user: {
              validateUserInfo: createSocialIdentityValidation({
                tenantId: "common",
                requireMicrosoftVerifiedEmailClaim: required,
                warn: (attributes) =>
                  logger.warn("auth.provider_claims_unavailable", attributes),
              }),
            },
            account: { accountLinking: SOCIAL_ACCOUNT_LINKING_OPTIONS },
            socialProviders: {
              microsoft: {
                clientId: "test-client",
                clientSecret: "test-secret",
                tenantId: "common",
                verifyIdToken: async () => true,
                getUserInfo: async () => ({
                  user: {
                    name: "Account",
                    email,
                    emailVerified: verified,
                  },
                  data: asTestRaw<MicrosoftEntraIDProfile>({
                    ...profile,
                    oid: "provider-account",
                    ...(verified ? { xms_edov: true } : {}),
                  }),
                }),
              },
            },
          });
          const response = await auth.api.signInSocial({
            body: {
              provider: "microsoft",
              idToken: { token: "test-credential" },
            },
            asResponse: true,
          });
          expect(response.ok).toBe(!required || verified);
          if (!required && !verified) {
            expect(warnings.length).toBeGreaterThan(0);
            for (const warning of warnings) {
              expect(warning).toEqual({
                severityText: "WARN",
                message: "auth.provider_claims_unavailable",
                attributes: {
                  provider: "microsoft",
                  tenantMode: "common",
                  missingClaims:
                    "xms_edov,email_verified,verified_primary_email,verified_secondary_email",
                },
              });
            }
          } else {
            expect(warnings).toEqual([]);
          }
        } finally {
          resetLogSinkForTesting();
        }
      }
    },
  );

  test.each([false, true])(
    "retains Microsoft tenant validation in claim mode: %s",
    async (required) => {
      for (const configured of [
        "common",
        "organizations",
        "consumers",
        tenantId,
      ]) {
        for (const identity of [
          { ...profile, xms_edov: true, iss: undefined },
          { ...profile, xms_edov: true, tid: undefined },
        ]) {
          const warnings: unknown[] = [];
          const auth = betterAuth({
            baseURL: "http://localhost:3001",
            secret: "test-secret-that-is-long-enough-for-better-auth",
            database: memoryAdapter({
              user: [],
              session: [],
              account: [],
              verification: [],
            }),
            user: {
              validateUserInfo: createSocialIdentityValidation({
                tenantId: configured,
                requireMicrosoftVerifiedEmailClaim: required,
                warn: (attributes) => {
                  warnings.push(attributes);
                },
              }),
            },
            socialProviders: {
              microsoft: {
                clientId: "test-client",
                clientSecret: "test-secret",
                tenantId: configured,
                verifyIdToken: async () => true,
                getUserInfo: async () => ({
                  user: {
                    name: "Account",
                    email,
                    emailVerified: true,
                  },
                  data: asTestRaw<MicrosoftEntraIDProfile>({
                    ...identity,
                    oid: "provider-account",
                  }),
                }),
              },
            },
          });
          const response = await auth.api.signInSocial({
            body: {
              provider: "microsoft",
              idToken: { token: "test-credential" },
            },
            asResponse: true,
          });
          expect(response.status).toBe(403);
          expect(warnings).toEqual([]);
        }
      }
    },
  );

  test.each([
    { existing: false, localEmailVerified: false },
    { existing: true, localEmailVerified: false },
    { existing: true, localEmailVerified: true },
  ])(
    "applies the identity policy to each account state: %j",
    async ({ existing, localEmailVerified }) => {
      for (const emailVerified of [false, true]) {
        const auth = betterAuth({
          baseURL: "http://localhost:3001",
          secret: "test-secret-that-is-long-enough-for-better-auth",
          database: memoryAdapter({
            user: [],
            session: [],
            account: [],
            verification: [],
          }),
          emailAndPassword: { enabled: true },
          user: {
            validateUserInfo: createSocialIdentityValidation({
              tenantId,
              requireMicrosoftVerifiedEmailClaim: false,
              warn: () => {},
            }),
          },
          account: { accountLinking: SOCIAL_ACCOUNT_LINKING_OPTIONS },
          socialProviders: {
            google: {
              clientId: "test-client",
              clientSecret: "test-secret",
              verifyIdToken: async () => true,
              getUserInfo: async () => ({
                user: {
                  name: "Account",
                  email,
                  emailVerified,
                },
                data: asTestRaw<GoogleProfile>({
                  sub: "provider-account",
                  email,
                  email_verified: emailVerified,
                }),
              }),
            },
          },
        });
        if (existing) {
          const local = await auth.api.signUpEmail({
            body: {
              email,
              name: "Account",
              password: "A secure password 123!",
            },
          });
          const context = await auth.$context;
          await context.internalAdapter.updateUser(local.user.id, {
            emailVerified: localEmailVerified,
          });
        }
        const response = await auth.api.signInSocial({
          body: { provider: "google", idToken: { token: "test-credential" } },
          asResponse: true,
        });
        const allowed = emailVerified && (!existing || localEmailVerified);
        expect(response.ok).toBe(allowed);
        const context = await auth.$context;
        const account = await context.internalAdapter.findAccountByKey({
          accountId: "provider-account",
          providerId: "google",
        });
        expect(Boolean(account)).toBe(allowed);
      }
    },
  );

  test("maps Microsoft email proof through the identity predicate", () => {
    const map = createMicrosoftProfileMapper(tenantId);
    const mapped = (claims: Record<string, unknown>) =>
      map(asTestRaw<MicrosoftEntraIDProfile>({ ...profile, ...claims }))
        .emailVerified;
    expect(mapped({ xms_edov: true })).toBe(true);
    expect(mapped({ email_verified: true })).toBe(true);
    expect(mapped({ verified_primary_email: [email.toUpperCase()] })).toBe(
      true,
    );
    expect(mapped({})).toBe(false);
    expect(mapped({ xms_edov: true, email_verified: false })).toBe(false);
    expect(mapped({ xms_edov: true, email: undefined })).toBe(false);
    expect(
      createMicrosoftProfileMapper("00000000-0000-4000-8000-000000000002")(
        asTestRaw<MicrosoftEntraIDProfile>({ ...profile, xms_edov: true }),
      ).emailVerified,
    ).toBe(false);
  });

  test.each([false, true])(
    "a linked Microsoft sign-in verifies the local email only on proof: %s",
    async (proven) => {
      let claims: Record<string, unknown> = {
        ...profile,
        oid: "provider-account",
      };
      const auth = betterAuth({
        baseURL: "http://localhost:3001",
        secret: "test-secret-that-is-long-enough-for-better-auth",
        database: memoryAdapter({
          user: [],
          session: [],
          account: [],
          verification: [],
        }),
        user: {
          validateUserInfo: createSocialIdentityValidation({
            tenantId,
            requireMicrosoftVerifiedEmailClaim: false,
            warn: () => {},
          }),
        },
        account: { accountLinking: SOCIAL_ACCOUNT_LINKING_OPTIONS },
        socialProviders: {
          microsoft: {
            clientId: "test-client",
            clientSecret: "test-secret",
            tenantId,
            verifyIdToken: async () => true,
            // An ID-token sign-in skips `mapProfileToUser`, so apply the
            // production mapper here the way the code flow does.
            getUserInfo: async () => {
              const data = asTestRaw<MicrosoftEntraIDProfile>(claims);
              return {
                user: {
                  name: "Account",
                  email,
                  ...createMicrosoftProfileMapper(tenantId)(data),
                },
                data,
              };
            },
          },
        },
      });
      const signIn = async () =>
        await auth.api.signInSocial({
          body: {
            provider: "microsoft",
            idToken: { token: "test-credential" },
          },
          asResponse: true,
        });

      // The first sign-in carries no proof, so the account starts unverified.
      expect((await signIn()).ok).toBe(true);
      const context = await auth.$context;
      const created = await context.internalAdapter.findUserByEmail(email);
      expect(created?.user.emailVerified).toBe(false);

      claims = { ...claims, ...(proven ? { xms_edov: true } : {}) };
      expect((await signIn()).ok).toBe(true);

      const user = await context.internalAdapter.findUserByEmail(email);
      expect(user?.user.emailVerified).toBe(proven);
    },
  );
});
