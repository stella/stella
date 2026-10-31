import {
  DECISION_TYPE_KIND_OTHER,
  DECISION_TYPE_KINDS,
  type DecisionTypeKind,
} from "@stll/api-contract/case-law-decision-types";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  decisionTypeKind,
  hasUnmappedDecisionType,
} from "@/api/lib/case-law/decision-type-kind";

export type DecisionKindAuditRow = {
  id: string;
  source: string;
  court: string;
  ecli?: string | null;
  stated: string | null;
  /** Only the decision's own title blocks, never citations or body text. */
  headings: readonly string[];
};

const HEADING_KINDS = [
  [/^(?:rozsudek|rozsudok)(?:\s|$)/u, "judgment"],
  [/^(?:usnesení|uznesenie)(?:\s|$)/u, "order"],
  [/^nález(?:\s|$)/u, "finding"],
  [/^(?:trestní příkaz|trestný rozkaz)(?:\s|$)/u, "penal_order"],
] as const;

/**
 * The ECLI court code, the only key that names one court across publishers. A
 * row without one is never compared by court name: two publishers can use the
 * same name for different courts.
 */
const ecliCourtKey = ({ ecli }: DecisionKindAuditRow) => {
  const [, country, code] = /^ECLI:(CZ|SK):([^:]+):/u.exec(ecli ?? "") ?? [];
  return country === undefined || code === undefined
    ? undefined
    : `${country}:${code}`;
};

type DecisionKindAuditOptions = {
  rows: readonly DecisionKindAuditRow[];
  vocabulary: Readonly<Record<string, readonly string[]>>;
  minimumSourceRows?: number;
  minimumShareJump?: number;
};

type SourceCounts = { total: number; kinds: Map<DecisionTypeKind, number> };

/** Signals are review candidates; they never override a publisher's stored value. */
export const auditDecisionKinds = ({
  rows,
  vocabulary,
  minimumSourceRows = 20,
  minimumShareJump = 0.25,
}: DecisionKindAuditOptions) => {
  const conflicts: {
    id: string;
    source: string;
    court: string;
    stated: string | null;
    mapped: DecisionTypeKind;
    headingKind: DecisionTypeKind;
  }[] = [];
  const missing: {
    source: string;
    stated: string | null;
    id: string | null;
  }[] = [];
  for (const [source, values] of Object.entries(vocabulary)) {
    for (const stated of values) {
      if (hasUnmappedDecisionType(stated)) {
        missing.push({ source, stated, id: null });
      }
    }
  }
  const courts = new Map<string, Map<string, SourceCounts>>();
  for (const row of rows) {
    const mapped = decisionTypeKind(row.stated);
    if (row.stated === null || hasUnmappedDecisionType(row.stated)) {
      missing.push({ source: row.source, stated: row.stated, id: row.id });
    }
    const headingKinds = new Set(
      row.headings.flatMap((heading) => {
        const normalized = normalizeUnicode(heading, "NFC")
          .toLowerCase()
          .replace(/\s+/gu, " ")
          .trim();
        return HEADING_KINDS.flatMap(([pattern, kind]) =>
          pattern.test(normalized) ? [kind] : [],
        );
      }),
    );
    // A title contradicts only a kind the publisher stated; an absent or
    // unknown type is reported as missing above, not as a conflict.
    const statesKind = mapped !== DECISION_TYPE_KIND_OTHER;
    const court = ecliCourtKey(row);
    for (const headingKind of statesKind ? headingKinds : []) {
      if (headingKind !== mapped) {
        conflicts.push({
          id: row.id,
          source: row.source,
          court: court ?? row.court,
          stated: row.stated,
          mapped,
          headingKind,
        });
      }
    }
    if (court === undefined) {
      continue;
    }
    const sources = courts.get(court) ?? new Map<string, SourceCounts>();
    courts.set(court, sources);
    const counts = sources.get(row.source) ?? {
      total: 0,
      kinds: new Map<DecisionTypeKind, number>(),
    };
    sources.set(row.source, counts);
    counts.total += 1;
    counts.kinds.set(mapped, (counts.kinds.get(mapped) ?? 0) + 1);
  }
  const shareJumps: {
    court: string;
    kind: DecisionTypeKind;
    sources: { source: string; count: number; total: number; share: number }[];
  }[] = [];
  for (const [court, sources] of courts) {
    for (const kind of DECISION_TYPE_KINDS) {
      const shares = [...sources]
        .filter(([, counts]) => counts.total >= minimumSourceRows)
        .map(([source, counts]) => ({
          source,
          count: counts.kinds.get(kind) ?? 0,
          total: counts.total,
          share: (counts.kinds.get(kind) ?? 0) / counts.total,
        }));
      if (shares.length < 2) {
        continue;
      }
      const values = shares.map(({ share }) => share);
      if (Math.max(...values) - Math.min(...values) >= minimumShareJump) {
        shareJumps.push({ court, kind, sources: shares });
      }
    }
  }
  return { rows: rows.length, missing, conflicts, shareJumps };
};
