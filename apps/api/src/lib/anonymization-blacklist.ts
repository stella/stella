import { Result } from "better-result";
import { and, asc, eq, isNull, or } from "drizzle-orm";

import type { GazetteerEntry } from "@stll/anonymize-wasm";

import type { ScopedDb } from "@/api/db";
import { anonymizationBlacklistEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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

export const normalizeAnonymizationBlacklistEntries = (
  entries: AnonymizationBlacklistEntryInput[],
) => {
  const seenCanonical = new Set<string>();
  const normalized = [];

  for (const entry of entries) {
    const next = normalizeAnonymizationBlacklistEntry(entry);
    if (next.canonical.length === 0 || next.label.length === 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Anonymization blacklist terms cannot be blank",
        }),
      );
    }

    const canonicalKey = next.canonical.toLocaleLowerCase();

    if (seenCanonical.has(canonicalKey)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Duplicate anonymization blacklist term",
        }),
      );
    }

    seenCanonical.add(canonicalKey);
    normalized.push(next);
  }

  return Result.ok(normalized);
};

export const loadAnonymizationGazetteerEntries = async ({
  organizationId,
  workspaceId,
  scopedDb,
}: {
  organizationId: SafeId<"organization">;
  /**
   * When provided, the load returns the union of:
   *   - org-wide entries (workspace_id IS NULL) — the firm
   *     default catalog.
   *   - entries scoped to this workspace (workspace_id = $).
   * When absent, only org-wide entries are returned.
   */
  workspaceId?: SafeId<"workspace"> | undefined;
  scopedDb: ScopedDb;
}) => {
  const workspaceMatch = workspaceId
    ? or(
        isNull(anonymizationBlacklistEntries.workspaceId),
        eq(anonymizationBlacklistEntries.workspaceId, workspaceId),
      )
    : isNull(anonymizationBlacklistEntries.workspaceId);

  const rows = await scopedDb((tx) =>
    tx
      .select({
        canonical: anonymizationBlacklistEntries.canonical,
        id: anonymizationBlacklistEntries.id,
        label: anonymizationBlacklistEntries.label,
        variants: anonymizationBlacklistEntries.variants,
        createdAt: anonymizationBlacklistEntries.createdAt,
        workspaceId: anonymizationBlacklistEntries.workspaceId,
      })
      .from(anonymizationBlacklistEntries)
      .where(
        and(
          eq(anonymizationBlacklistEntries.organizationId, organizationId),
          eq(anonymizationBlacklistEntries.enabled, true),
          workspaceMatch,
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
      workspaceId: row.workspaceId ?? organizationId,
      createdAt: row.createdAt.getTime(),
      source: "manual",
    }),
  );
};

// TODO: Add org-wide custom regex rules here once @stll/anonymize-wasm
// exposes a safe first-class custom regex detector API.
