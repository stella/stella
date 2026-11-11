import { panic } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type {
  ConflictCheckView,
  ConflictHit,
  ConflictSeverity,
  ConflictVisibleMatter,
  ConflictWalledMatters,
} from "@stll/api-contract/conflict-checks";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { conflictChecks } from "@/api/db/schema";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readConflictMatterAccess } from "@/api/lib/conflict-check/links";
import type { ConflictMatterAccess } from "@/api/lib/conflict-check/links";
import { hitSeverity } from "@/api/lib/conflict-check/outcome";
import type {
  StoredConflictHit,
  StoredConflictResults,
} from "@/api/lib/conflict-check/stored-results";

export type ConflictCheckRow = Pick<
  typeof conflictChecks.$inferSelect,
  | "id"
  | "title"
  | "runBy"
  | "parties"
  | "results"
  | "outcome"
  | "decision"
  | "decidedBy"
  | "decidedAt"
  | "decisionNote"
  | "consentReference"
  | "createdAt"
>;

type Person = { userId: string; name: string };

type MatterFacts = {
  access: ReadonlyMap<string, ConflictMatterAccess>;
  /** Name and reference of matters the reader may open, read under row security. */
  visible: ReadonlyMap<string, { name: string; reference: string }>;
  people: ReadonlyMap<string, string>;
};

const WALLED_SEVERITIES = ["potential_conflict", "needs_review"] as const;

const walledGroups = (
  walled: readonly {
    severity: ConflictSeverity;
    contactUserId: string | null;
  }[],
  people: ReadonlyMap<string, string>,
): ConflictWalledMatters[] =>
  WALLED_SEVERITIES.flatMap((severity) => {
    const matters = walled.filter((matter) => matter.severity === severity);
    if (matters.length === 0) {
      return [];
    }
    const contactIds = [
      ...new Set(
        matters.flatMap((matter) =>
          matter.contactUserId === null ? [] : [matter.contactUserId],
        ),
      ),
    ];
    const contacts = contactIds.flatMap((personId) => {
      const name = people.get(personId);
      return name === undefined ? [] : [{ userId: personId, name }];
    });
    return [
      {
        severity,
        count: matters.length,
        contacts,
        askAdministrator:
          contacts.length < contactIds.length ||
          matters.some((matter) => matter.contactUserId === null),
      },
    ];
  });

/**
 * One hit as this reader may see it. A link the runner could open stays open
 * only while this reader may open the matter too; otherwise it becomes a
 * walled count with its severity, like a link the runner could not open. A
 * walled link discloses no role and no state, and an informational one is not
 * shown at all.
 */
const projectHit = (
  hit: StoredConflictHit,
  facts: MatterFacts,
): ConflictHit => {
  const matters: ConflictVisibleMatter[] = [];
  const walled: { severity: ConflictSeverity; contactUserId: string | null }[] =
    [];
  let deletedMatters = 0;
  for (const link of hit.links) {
    const access = facts.access.get(link.workspaceId);
    if (access === undefined) {
      deletedMatters += 1;
      continue;
    }
    const visible =
      link.access === "visible" && access.accessible
        ? facts.visible.get(link.workspaceId)
        : undefined;
    if (link.access === "visible" && visible !== undefined) {
      matters.push({
        workspaceId: link.workspaceId,
        name: visible.name,
        reference: visible.reference,
        relation: link.relation,
        role: link.role,
        state: link.state,
        severity: link.severity,
      });
      continue;
    }
    walled.push({
      severity: link.severity,
      contactUserId: access.contactUserId,
    });
  }
  return {
    contactId: hit.contactId,
    contactName: hit.contactName,
    contactType: hit.contactType,
    tier: hit.tier,
    score: hit.score,
    matchedName: hit.matchedName,
    evidence: hit.evidence,
    severity: hitSeverity(hit),
    matters,
    walled: walledGroups(walled, facts.people),
    deletedMatters,
  };
};

const readMatterFacts = async ({
  tx,
  organizationId,
  results,
  personIds,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  results: StoredConflictResults;
  personIds: readonly (string | null)[];
}): Promise<MatterFacts> => {
  const workspaceIds = [
    ...new Set(
      results.parties.flatMap((party) =>
        party.hits.flatMap((hit) => hit.links.map((link) => link.workspaceId)),
      ),
    ),
  ];
  const access = await readConflictMatterAccess({
    tx,
    organizationId,
    workspaceIds,
  });
  const openable = workspaceIds.filter((id) => access.get(id)?.accessible);
  // Row security decides which names this reader gets, whatever the routine said.
  const visibleRows =
    openable.length === 0
      ? []
      : await tx
          .select({
            id: workspaces.id,
            name: workspaces.name,
            reference: workspaces.reference,
          })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.organizationId, organizationId),
              inArray(workspaces.id, openable),
            ),
          );
  const userIds = [
    ...new Set([
      ...personIds.filter((id): id is string => id !== null),
      ...[...access.values()].flatMap((matter) =>
        matter.contactUserId === null ? [] : [matter.contactUserId],
      ),
    ]),
  ];
  // Names come through membership of this organization: a former member is
  // shown as nobody, and a walled matter's lead who left reads as "ask an
  // administrator".
  const userRows =
    userIds.length === 0
      ? []
      : await tx
          .select({ id: user.id, name: user.name })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(
            and(
              eq(member.organizationId, organizationId),
              inArray(member.userId, userIds),
            ),
          );
  return {
    access,
    visible: new Map(
      visibleRows.map((row) => [
        row.id,
        { name: row.name, reference: row.reference },
      ]),
    ),
    people: new Map(userRows.map((row) => [row.id, row.name])),
  };
};

const person = (
  id: string | null,
  people: ReadonlyMap<string, string>,
): Person | null => {
  if (id === null) {
    return null;
  }
  const name = people.get(id);
  return name === undefined ? null : { userId: id, name };
};

/**
 * The single projection of a stored check for one reader. Every surface (the
 * HTTP route, and later chat and MCP) returns this and nothing else, so a
 * matter the reader may not open is disclosed the same way everywhere.
 */
export const projectConflictCheck = async ({
  tx,
  organizationId,
  row,
  workspaceId,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  row: ConflictCheckRow;
  workspaceId: SafeId<"workspace"> | null;
}): Promise<ConflictCheckView> => {
  const facts = await readMatterFacts({
    tx,
    organizationId,
    results: row.results,
    personIds: [row.runBy, row.decidedBy],
  });
  const { parties } = row;
  return {
    id: row.id,
    title: row.title,
    outcome: row.outcome,
    coverage: {
      contactsScreened: row.results.contactsScreened,
      gaps: row.results.gaps,
    },
    parties: row.results.parties.map((result, index) => ({
      // A stored check always holds one result per submitted party.
      party: parties[index] ?? panic("A stored conflict check lost a party"),
      hits: result.hits.map((hit) => projectHit(hit, facts)),
      totalMatches: result.totalMatches,
      truncated: result.truncated,
      incomplete: result.incomplete,
    })),
    decision: row.decision,
    decisionNote: row.decisionNote,
    consentReference: row.consentReference,
    decidedBy: person(row.decidedBy, facts.people),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    runBy: person(row.runBy, facts.people),
    workspaceId,
    createdAt: row.createdAt.toISOString(),
  };
};
