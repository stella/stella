import { describe, expect, test } from "bun:test";
import path from "node:path";

import type { env } from "@/api/env";
import { decideFeatureAccess } from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";

import { withSeededOrganizationGrants } from "./lib/seeded-organization-grants";
import { DEFAULT_ORG_ID, DEFAULT_USER_ID } from "./seed-utils";

const apiRoot = path.resolve(import.meta.dirname, "..");
const PRELOAD = "./scripts/grant-seeded-organization-features.ts";
const OPERATOR_GRANTS = {
  [LEGAL_LISTS_FEATURE_ID]: [
    { type: "organization", organizationId: "org-operator" },
  ],
} satisfies typeof env.API_FEATURE_ACCESS_GRANTS;

const runWithPreload = async (env: Record<string, string>) => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      PRELOAD,
      "-e",
      'const { envFeatureAccess } = await import("@/api/env-feature-access"); console.log(JSON.stringify(envFeatureAccess.API_FEATURE_ACCESS_GRANTS));',
    ],
    {
      cwd: apiRoot,
      env: {
        ...process.env,
        API_FEATURE_ACCESS_GRANTS: JSON.stringify(OPERATOR_GRANTS),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

describe("seeded organization feature grants", () => {
  test("admit the seeded organization to every registered feature", () => {
    const grants = withSeededOrganizationGrants({});
    // Self-serve features admit through enrolment rows, not grants.
    const enrolments = Object.entries(FEATURE_REGISTRY)
      .filter(([, { enrolment }]) => enrolment === "self-serve")
      .map(([featureId]) => ({
        featureId,
        organizationId: DEFAULT_ORG_ID,
        userId: DEFAULT_USER_ID,
      }));
    const hidden = Object.keys(FEATURE_REGISTRY).filter(
      (featureId) =>
        decideFeatureAccess({
          registry: FEATURE_REGISTRY,
          grants,
          featureId,
          organizationId: DEFAULT_ORG_ID,
          userId: DEFAULT_USER_ID,
          user: { email: "test@stella.dev", emailVerified: true },
          membership: true,
          enrolments,
        }).status !== "enabled",
    );
    expect(hidden).toEqual([]);
  });

  test("keep configured grants alongside the seeded organization's", () => {
    expect(
      withSeededOrganizationGrants(OPERATOR_GRANTS)[LEGAL_LISTS_FEATURE_ID],
    ).toEqual([
      { type: "organization", organizationId: "org-operator" },
      { type: "organization", organizationId: DEFAULT_ORG_ID },
    ]);
  });

  test("the preload installs the grants in a local development process", async () => {
    const { stdout, stderr, exitCode } = await runWithPreload({
      NODE_ENV: "development",
      STELLA_LOCAL_DEV: "1",
    });
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(
      withSeededOrganizationGrants(OPERATOR_GRANTS),
    );
  });

  test.each([
    {
      optIn: "",
      message:
        "Seeded organization feature grants requires local development access",
    },
    {
      optIn: "1",
      message: "STELLA_LOCAL_DEV=1 requires NODE_ENV=development or test",
    },
  ])(
    "the preload refuses production with opt-in '$optIn'",
    async ({ optIn, message }) => {
      const { stdout, stderr, exitCode } = await runWithPreload({
        NODE_ENV: "production",
        STELLA_LOCAL_DEV: optIn,
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(message);
      expect(stdout).toBe("");
    },
  );
});
