import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { requireLocalDevOpen } from "@/api/runtime-mode";

// Refuse before importing the database-owning seed module.
requireLocalDevOpen("Feature access seeding");

const { ensureTestUsers } = await import("./seed-test-user");
const organizationId = Bun.randomUUIDv7();
await ensureTestUsers(organizationId);

const grants = {
  [LEGAL_LISTS_FEATURE_ID]: [{ type: "organization", organizationId }],
} as const satisfies FeatureAccessGrants;
const directory = path.resolve(import.meta.dirname, "../../../.playwright");
await mkdir(directory, { recursive: true });
await writeFile(
  path.join(directory, "feature-access.json"),
  JSON.stringify({ organizationId, grants }),
  { mode: 0o600 },
);
process.exit(0);
