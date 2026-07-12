import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { clauses, clauseVariants, clauseVersions } from "@/api/db/schema";
import { clauseBodyToPlainText } from "@/api/handlers/clauses/clause-to-patch";
import type { GradedPosition } from "@/api/handlers/playbooks/position-runtime";
import type {
  Position,
  ResolvedTiers,
} from "@/api/handlers/playbooks/positions";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedClauseId } from "@/api/lib/safe-id-boundaries";

// Shared tier resolution: turn each graded position's tiered ladder into a
// run-time snapshot (`ResolvedTiers`) of ideal text, ranked fallbacks, and
// acceptable/red-line rule texts. Both the files-table run (`materialize-run.ts`,
// snapshotting the verdict tool) and the single-doc ephemeral review
// (`review.ts`, grading in memory) resolve the same way, so what a verdict is
// graded against is identical across surfaces.

// Each text is capped so a long clause body cannot bloat a verdict snapshot
// beyond the schema's documented limits (`resolvedTiersSchema`).
const MAX_STANDARD_TEXT = 10_000;
// The resolved fallbacks array is capped at 10 (explicit entries win, appended
// clause variants fill the remainder). Matches `resolvedTiersSchema`'s maxItems.
const MAX_FALLBACKS = 10;

const capText = (text: string): string =>
  text.length > MAX_STANDARD_TEXT ? text.slice(0, MAX_STANDARD_TEXT) : text;

const gradedPositions = (positions: readonly Position[]): GradedPosition[] =>
  positions.filter(
    (position): position is GradedPosition => position.mode === "graded",
  );

type ClauseSnapshot = {
  preferredBody: string;
  pinnedBodyByVersion: Map<number, string>;
  // Clause variants, ranked by their authored sort order; appended after a
  // position's explicit fallback entries when its ideal is clause-sourced.
  variants: { rank: number; text: string }[];
};

export const loadClauseSnapshots = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  positions: readonly Position[],
): Promise<Map<string, ClauseSnapshot>> => {
  const graded = gradedPositions(positions);
  const clauseIds = [
    ...new Set(
      graded.flatMap((position) =>
        position.tiers.acceptable.ideal?.source === "clause"
          ? [position.tiers.acceptable.ideal.clauseId]
          : [],
      ),
    ),
  ].map((id) => brandPersistedClauseId(id));

  if (clauseIds.length === 0) {
    return new Map();
  }

  // Only pinned `(clauseId, version)` pairs are ever read (resolveTiers uses the
  // latest body when an ideal has no pinned version), so restrict the history
  // read to those exact pairs instead of every version of each clause.
  const pinnedVersionPairs = graded.flatMap((position) => {
    const ideal = position.tiers.acceptable.ideal;
    return ideal?.source === "clause" && ideal.clauseVersion !== undefined
      ? [
          {
            clauseId: brandPersistedClauseId(ideal.clauseId),
            version: ideal.clauseVersion,
          },
        ]
      : [];
  });
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
      variants: [],
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
      snapshot.variants.push({ rank: variant.sortOrder, text: capText(text) });
    }
  }
  return snapshots;
};

type ResolvedFallback = { rank: number; label?: string; text: string };

// Resolve a graded position's tiers into the verdict-time snapshot. Fallbacks
// are the position's explicit entries first (in authored order), then the
// ideal clause's variants appended after them — restoring the fidelity v1 could
// not express (entries and variants coexisting). The merged list is ranked by
// its final position and capped at MAX_FALLBACKS, so a grader's `matched.rank`
// indexes this array directly.
export const resolveTiers = (
  position: GradedPosition,
  clauseSnapshots: ReadonlyMap<string, ClauseSnapshot>,
): ResolvedTiers => {
  const { tiers } = position;

  const acceptableRules = tiers.acceptable.rules
    .map((rule) => ({ id: rule.id, text: rule.text.trim() }))
    .filter((rule) => rule.text.length > 0)
    .map((rule) => ({ id: rule.id, text: capText(rule.text) }));
  const notAcceptableRules = tiers.notAcceptable.rules
    .map((rule) => ({ id: rule.id, text: rule.text.trim() }))
    .filter((rule) => rule.text.length > 0)
    .map((rule) => ({ id: rule.id, text: capText(rule.text) }));

  let ideal: string | undefined;
  let idealClauseVariants: { rank: number; text: string }[] = [];
  const idealCfg = tiers.acceptable.ideal;
  if (idealCfg?.source === "inline") {
    const trimmed = idealCfg.text.trim();
    if (trimmed.length > 0) {
      ideal = capText(trimmed);
    }
  } else if (idealCfg?.source === "clause") {
    const snapshot = clauseSnapshots.get(idealCfg.clauseId);
    if (snapshot) {
      const body =
        idealCfg.clauseVersion !== undefined
          ? (snapshot.pinnedBodyByVersion.get(idealCfg.clauseVersion) ??
            snapshot.preferredBody)
          : snapshot.preferredBody;
      const trimmed = body.trim();
      if (trimmed.length > 0) {
        ideal = capText(trimmed);
      }
      idealClauseVariants = snapshot.variants;
    }
  }

  // Explicit entries first (they win the cap), then clause variants; re-rank by
  // final array position so `rank` always equals the index used to resolve a
  // `matchedRef`.
  const merged: { label?: string; text: string }[] = [];
  for (const entry of tiers.fallback.entries) {
    const text = entry.text.trim();
    if (text.length === 0) {
      continue;
    }
    merged.push({
      ...(entry.label === undefined ? {} : { label: entry.label }),
      text: capText(text),
    });
  }
  for (const variant of idealClauseVariants) {
    merged.push({ text: variant.text });
  }
  const fallbacks: ResolvedFallback[] = merged
    .slice(0, MAX_FALLBACKS)
    .map((entry, index) => {
      const fallback: ResolvedFallback = { rank: index, text: entry.text };
      if (entry.label !== undefined) {
        fallback.label = entry.label;
      }
      return fallback;
    });

  return {
    ...(ideal === undefined ? {} : { ideal }),
    fallbacks,
    acceptableRules,
    notAcceptableRules,
  };
};
