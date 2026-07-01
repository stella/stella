import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { clauses, clauseVariants, clauseVersions } from "@/api/db/schema";
import { clauseBodyToPlainText } from "@/api/handlers/clauses/clause-to-patch";
import type {
  Position,
  ResolvedStandard,
} from "@/api/handlers/playbooks/positions";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedClauseId } from "@/api/lib/safe-id-boundaries";

// Shared EXPECT-standard resolution: turn each position's clause/inline/none
// standard into a run-time snapshot of preferred + ranked fallback texts. Both
// the files-table run (`run.ts`, materializing a verdict tool) and the
// single-doc ephemeral review (`review.ts`, grading in memory) resolve the same
// way, so the snapshot a verdict is graded against is identical across surfaces.

// Each text is capped so a long clause body cannot bloat a verdict snapshot
// beyond the schema's documented limits (`resolvedStandardSchema`).
const MAX_STANDARD_TEXT = 10_000;
const MAX_FALLBACKS = 10;

const capText = (text: string): string =>
  text.length > MAX_STANDARD_TEXT ? text.slice(0, MAX_STANDARD_TEXT) : text;

type ClauseSnapshot = {
  preferredBody: string;
  pinnedBodyByVersion: Map<number, string>;
  fallbacks: { rank: number; text: string }[];
};

export const loadClauseSnapshots = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  positions: readonly Position[],
): Promise<Map<string, ClauseSnapshot>> => {
  const clauseIds = [
    ...new Set(
      positions.flatMap((position) =>
        position.standard.source === "clause"
          ? [position.standard.clauseId]
          : [],
      ),
    ),
  ].map((id) => brandPersistedClauseId(id));

  if (clauseIds.length === 0) {
    return new Map();
  }

  // Only pinned `(clauseId, version)` pairs are ever read (resolveStandard uses
  // the latest body when a standard has no pinned version), so restrict the
  // history read to those exact pairs instead of every version of each clause.
  const pinnedVersionPairs = positions.flatMap((position) =>
    position.standard.source === "clause" &&
    position.standard.clauseVersion !== undefined
      ? [
          {
            clauseId: brandPersistedClauseId(position.standard.clauseId),
            version: position.standard.clauseVersion,
          },
        ]
      : [],
  );
  const versionConditions = pinnedVersionPairs.map((pair) =>
    and(
      eq(clauseVersions.clauseId, pair.clauseId),
      eq(clauseVersions.version, pair.version),
    ),
  );
  const versionRowsPromise =
    versionConditions.length > 0
      ? tx
          .select({
            clauseId: clauseVersions.clauseId,
            version: clauseVersions.version,
            body: clauseVersions.body,
          })
          .from(clauseVersions)
          .where(
            and(
              eq(clauseVersions.organizationId, organizationId),
              or(...versionConditions),
            ),
          )
      : Promise.resolve<
          Pick<
            typeof clauseVersions.$inferSelect,
            "clauseId" | "version" | "body"
          >[]
        >([]);

  const [clauseRows, variantRows, versionRows] = await Promise.all([
    tx
      .select({ id: clauses.id, body: clauses.body })
      .from(clauses)
      .where(
        and(
          eq(clauses.organizationId, organizationId),
          inArray(clauses.id, clauseIds),
        ),
      ),
    tx
      .select({
        clauseId: clauseVariants.clauseId,
        body: clauseVariants.body,
        sortOrder: clauseVariants.sortOrder,
      })
      .from(clauseVariants)
      .where(
        and(
          eq(clauseVariants.organizationId, organizationId),
          inArray(clauseVariants.clauseId, clauseIds),
        ),
      )
      .orderBy(asc(clauseVariants.sortOrder))
      .limit(clauseIds.length * LIMITS.clauseVariantsPerClause),
    versionRowsPromise,
  ]);

  const snapshots = new Map<string, ClauseSnapshot>();
  for (const clause of clauseRows) {
    snapshots.set(clause.id, {
      preferredBody: clauseBodyToPlainText(clause.body),
      pinnedBodyByVersion: new Map(),
      fallbacks: [],
    });
  }
  for (const version of versionRows) {
    snapshots
      .get(version.clauseId)
      ?.pinnedBodyByVersion.set(
        version.version,
        clauseBodyToPlainText(version.body),
      );
  }
  for (const variant of variantRows) {
    const snapshot = snapshots.get(variant.clauseId);
    if (!snapshot) {
      continue;
    }
    const text = clauseBodyToPlainText(variant.body).trim();
    if (text.length > 0) {
      snapshot.fallbacks.push({ rank: variant.sortOrder, text: capText(text) });
    }
  }
  return snapshots;
};

export const resolveStandard = (
  position: Position,
  clauseSnapshots: ReadonlyMap<string, ClauseSnapshot>,
): ResolvedStandard => {
  const { standard } = position;
  if (standard.source === "none") {
    return {};
  }

  if (standard.source === "inline") {
    const preferred = standard.preferred?.trim();
    const fallbacks = (standard.fallbacks ?? [])
      .map((fallback) => ({ rank: fallback.rank, text: fallback.text.trim() }))
      .filter((fallback) => fallback.text.length > 0)
      .slice(0, MAX_FALLBACKS)
      .map((fallback) => ({
        rank: fallback.rank,
        text: capText(fallback.text),
      }));
    return {
      ...(preferred && preferred.length > 0
        ? { preferred: capText(preferred) }
        : {}),
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
    };
  }

  // source === "clause": resolve the pinned (or latest) body + ranked variants.
  const snapshot = clauseSnapshots.get(standard.clauseId);
  if (!snapshot) {
    return {};
  }
  const preferredBody =
    standard.clauseVersion !== undefined
      ? (snapshot.pinnedBodyByVersion.get(standard.clauseVersion) ??
        snapshot.preferredBody)
      : snapshot.preferredBody;
  const preferred = preferredBody.trim();
  const fallbacks = snapshot.fallbacks.slice(0, MAX_FALLBACKS);
  return {
    ...(preferred.length > 0 ? { preferred: capText(preferred) } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
};
