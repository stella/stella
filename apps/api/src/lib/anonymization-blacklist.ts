import type { GazetteerEntry } from "@stll/anonymize-wasm";
import { and, asc, eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { anonymizationBlacklistEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type AnonymizationBlacklistEntryInput = {
  canonical: string;
  enabled?: boolean | undefined;
  label: string;
  variants?: string[] | undefined;
};

const normalizeTerm = (value: string): string => value.trim();

const normalizeVariants = (variants: readonly string[]): string[] => {
  const normalized = new Set<string>();

  for (const variant of variants) {
    const value = normalizeTerm(variant);
    if (value.length > 0) {
      normalized.add(value);
    }
  }

  return [...normalized];
};

export const normalizeAnonymizationBlacklistEntry = ({
  canonical,
  enabled,
  label,
  variants,
}: AnonymizationBlacklistEntryInput) => ({
  canonical: normalizeTerm(canonical),
  enabled: enabled ?? true,
  label: normalizeTerm(label),
  variants: normalizeVariants(variants ?? []),
});

export const loadAnonymizationGazetteerEntries = async ({
  organizationId,
  scopedDb,
}: {
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
}) => {
  const rows = await scopedDb((tx) =>
    tx
      .select({
        canonical: anonymizationBlacklistEntries.canonical,
        id: anonymizationBlacklistEntries.id,
        label: anonymizationBlacklistEntries.label,
        variants: anonymizationBlacklistEntries.variants,
        createdAt: anonymizationBlacklistEntries.createdAt,
      })
      .from(anonymizationBlacklistEntries)
      .where(
        and(
          eq(anonymizationBlacklistEntries.organizationId, organizationId),
          eq(anonymizationBlacklistEntries.enabled, true),
        ),
      )
      .orderBy(asc(anonymizationBlacklistEntries.canonical)),
  );

  return rows.map(
    (row): GazetteerEntry => ({
      id: row.id,
      canonical: row.canonical,
      label: row.label,
      variants: row.variants,
      workspaceId: organizationId,
      createdAt: row.createdAt.getTime(),
      source: "manual",
    }),
  );
};

// TODO: Add org-wide custom regex rules here once @stll/anonymize-wasm
// exposes a safe first-class custom regex detector API.
