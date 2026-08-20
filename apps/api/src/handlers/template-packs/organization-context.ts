import { and, eq, sql } from "drizzle-orm";

import { isCountryCode, type CountryCode } from "@stll/country-codes";

import type { SafeDb } from "@/api/db/safe-db";
import { templates } from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";

export type TemplatePackOrganizationContext = {
  /** Practice jurisdictions as country codes, primary first. */
  countries: CountryCode[];
  hidden: boolean;
};

/** Practice jurisdictions and the pack-offer preference; defaults when the
 *  organization has never saved settings. */
export const readTemplatePackOrganizationContext = async (
  safeDb: SafeDb,
  organizationId: SafeId<"organization">,
) =>
  await safeDb(async (tx): Promise<TemplatePackOrganizationContext> => {
    const row = await tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: { practiceJurisdictions: true, templatePacksHidden: true },
    });
    const jurisdictions = arrayOrEmpty(row?.practiceJurisdictions);
    const countries = [...jurisdictions]
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .map((jurisdiction) => jurisdiction.countryCode)
      .filter(isCountryCode);
    return { countries, hidden: row?.templatePacksHidden ?? false };
  });

export type InstalledPackTemplate = {
  slug: string;
  templateId: SafeId<"template">;
};

/** Templates of one pack already installed in the organization, by slug.
 *  Served by the partial unique index on (organization, packId, slug). */
export const readInstalledPackTemplates = async (
  safeDb: SafeDb,
  {
    organizationId,
    packId,
  }: { organizationId: SafeId<"organization">; packId: string },
) =>
  await safeDb(async (tx): Promise<Map<string, SafeId<"template">>> => {
    const rows = await tx
      .select({
        id: templates.id,
        slug: sql<string>`${templates.origin}->>'slug'`,
      })
      .from(templates)
      .where(
        and(
          eq(templates.organizationId, organizationId),
          eq(templates.originType, "bundled-pack"),
          eq(sql`${templates.origin}->>'packId'`, packId),
        ),
      );
    return new Map(rows.map((row) => [row.slug, row.id] as const));
  });

/** Number of templates installed from any pack, per pack id. */
export const readInstalledPackCounts = async (
  safeDb: SafeDb,
  organizationId: SafeId<"organization">,
) =>
  await safeDb(async (tx): Promise<Map<string, number>> => {
    const rows = await tx
      .select({
        packId: sql<string>`${templates.origin}->>'packId'`,
        count: sql<number>`count(*)::int`,
      })
      .from(templates)
      .where(
        and(
          eq(templates.organizationId, organizationId),
          eq(templates.originType, "bundled-pack"),
        ),
      )
      .groupBy(sql`${templates.origin}->>'packId'`);
    return new Map(rows.map((row) => [row.packId, row.count] as const));
  });
