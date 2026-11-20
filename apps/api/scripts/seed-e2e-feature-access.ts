import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import {
  e2eFeatureAccessFixtureSchema,
  routeSmokeScaleEmail,
  type RouteSmokeScaleSize,
} from "@stll/scripts/src/e2e-feature-access-fixture";

import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { requireLocalDevOpen } from "@/api/runtime-mode";

// Refuse before importing the database-owning seed module.
requireLocalDevOpen("Feature access seeding");

const { ensureMembershipExists, ensureOrganizationExists, ensureUserExists } =
  await import("./seed-test-user");
const organizationId = Bun.randomUUIDv7();
const email = `lists-${organizationId}@stella.dev`;
// Keep the shared test users in their original organization: OAuth journeys
// rely on their single membership to resume consent without an org picker.
const userId = await ensureUserExists({
  id: Bun.randomUUIDv7(),
  name: "Lists browser test",
  email,
});
await ensureOrganizationExists(organizationId);
await ensureMembershipExists({ organizationId, userId, role: "owner" });

const seedScaleOwner = async (size: RouteSmokeScaleSize) => {
  const scaleOrganizationId = Bun.randomUUIDv7();
  const scaleEmail = routeSmokeScaleEmail(size, scaleOrganizationId);
  const scaleUserId = await ensureUserExists({
    id: Bun.randomUUIDv7(),
    name: `Route smoke ${size}`,
    email: scaleEmail,
  });
  await ensureOrganizationExists(scaleOrganizationId);
  await ensureMembershipExists({
    organizationId: scaleOrganizationId,
    userId: scaleUserId,
    role: "owner",
  });
  return { organizationId: scaleOrganizationId, email: scaleEmail };
};
const routeSmokeScale = {
  small: await seedScaleOwner("small"),
  large: await seedScaleOwner("large"),
};

const grants = {
  [LEGAL_LISTS_FEATURE_ID]: [
    { type: "organization", organizationId },
    ...Object.values(routeSmokeScale).map(({ organizationId: id }) => ({
      type: "organization" as const,
      organizationId: id,
    })),
  ],
} as const satisfies FeatureAccessGrants;
const directory = path.resolve(import.meta.dirname, "../../../.playwright");
await mkdir(directory, { recursive: true });
await writeFile(
  path.join(directory, "feature-access.json"),
  JSON.stringify(
    v.parse(e2eFeatureAccessFixtureSchema, {
      organizationId,
      email,
      grants,
      routeSmokeScale,
    }),
  ),
  { mode: 0o600 },
);
process.exit(0);
