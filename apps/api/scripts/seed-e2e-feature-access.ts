import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

const grants = {
  [LEGAL_LISTS_FEATURE_ID]: [{ type: "organization", organizationId }],
} as const satisfies FeatureAccessGrants;
const directory = path.resolve(import.meta.dirname, "../../../.playwright");
await mkdir(directory, { recursive: true });
await writeFile(
  path.join(directory, "feature-access.json"),
  JSON.stringify({ organizationId, email, grants }),
  { mode: 0o600 },
);
process.exit(0);
