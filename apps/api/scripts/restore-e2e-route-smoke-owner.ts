import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";
import {
  e2eFeatureAccessFixtureSchema,
  ROUTE_SMOKE_SCALE_SIZES,
  seededOrganizationSlug,
} from "@stll/scripts/src/e2e-feature-access-fixture";

import { requireLocalDevOpen } from "@/api/runtime-mode";

requireLocalDevOpen("Restoring a granted route smoke owner");

await runScriptWithErrorOutput(async () => {
  const size = v.parse(v.picklist(ROUTE_SMOKE_SCALE_SIZES), process.argv.at(2));
  const fixturePath = path.resolve(
    import.meta.dirname,
    "../../../.playwright/feature-access.json",
  );
  const fixture = v.parse(
    e2eFeatureAccessFixtureSchema,
    JSON.parse(await readFile(fixturePath, "utf-8")),
  );
  const { organizationId, email } = fixture.routeSmokeScale[size];
  const [{ organization }, { openMaintenanceDb }, seed] = await Promise.all([
    import("@/api/db/auth-schema"),
    import("@/api/lib/db/maintenance-db"),
    import("./seed-test-user"),
  ]);
  const db = openMaintenanceDb({ readOnly: true });
  const existing = (
    await db.execute<{ slug: string }>(sql`
      SELECT ${organization.slug} AS slug
      FROM ${organization}
      WHERE ${organization.id} = ${organizationId}
      LIMIT 1
    `)
  ).at(0);
  if (
    existing !== undefined &&
    existing.slug !== seededOrganizationSlug(organizationId)
  ) {
    panic("Route smoke fixture organization identity does not match");
  }
  const userId = await seed.ensureUserExists({
    id: Bun.randomUUIDv7(),
    name: `Route smoke ${size}`,
    email,
  });
  await seed.ensureOrganizationExists(organizationId);
  await seed.ensureMembershipExists({ organizationId, userId, role: "owner" });
});
process.exit(0);
