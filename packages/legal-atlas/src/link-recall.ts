import {
  auditDecisionKey,
  type AuditReference,
  type LinkRecallKind,
} from "./link-recall-reference";

export type StoredAuditReference = {
  kind: LinkRecallKind;
  key: string;
  status: "metadata" | "extracted" | "linked";
};

type CompareAuditReferencesOptions = {
  references: readonly AuditReference[];
  stored: readonly StoredAuditReference[];
};

/** Count distinct targets per decision/kind; retain every missed passage. */
export const compareAuditReferences = ({
  references,
  stored,
}: CompareAuditReferencesOptions) => {
  const extracted = new Set<string>();
  const linked = new Set<string>();
  for (const reference of stored) {
    const identity = `${reference.kind}:${reference.key}`;
    extracted.add(identity);
    if (reference.status === "linked") {
      linked.add(identity);
    }
  }
  const targets = new Map<
    string,
    { kind: LinkRecallKind; key: string; extracted: boolean; linked: boolean }
  >();
  const misses: (AuditReference & {
    reason: "not-extracted" | "not-linked";
  })[] = [];
  for (const reference of references) {
    const identity = `${reference.kind}:${reference.key}`;
    const present = extracted.has(identity);
    const resolved = linked.has(identity);
    targets.set(identity, {
      kind: reference.kind,
      key: reference.key,
      extracted: present,
      linked: resolved,
    });
    if (!resolved) {
      misses.push({
        ...reference,
        reason: present ? "not-linked" : "not-extracted",
      });
    }
  }
  return { targets: [...targets.values()], misses };
};

type StoredDecisionAuditReferencesOptions = {
  text: string;
  kind: "precedent" | "procedural";
  status: "extracted" | "linked";
};

/** A resolved precedent alone does not prove the case's procedural relationship. */
export const storedDecisionAuditReferences = ({
  text,
  kind,
  status,
}: StoredDecisionAuditReferencesOptions): StoredAuditReference[] => {
  const key = auditDecisionKey(text);
  const decision = { kind: "decision", key, status } as const;
  if (kind === "precedent") {
    return [decision];
  }
  return [
    decision,
    { kind: "reviewed-decision", key, status },
    { kind: "procedural-history", key, status },
  ];
};
