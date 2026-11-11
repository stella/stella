import { panic } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import {
  CONFLICT_MATTER_STATES,
  CONFLICT_RELATIONS,
  CONFLICT_SEVERITIES,
} from "@stll/api-contract/conflict-checks";
import type { ConflictPartyRole } from "@stll/api-contract/conflict-checks";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import type { StoredConflictLink } from "@/api/lib/conflict-check/stored-results";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { typedPgArray } from "@/api/lib/search/sql";

/**
 * The organization's matters reach a conflict check only through the two
 * database routines below (migration `20261111160200_conflict_checks`). They
 * run with the owner's rights so a check covers matters its runner cannot
 * open, yet for such a matter they return only its id and a severity they
 * computed themselves: the contact's role and the matter's state stay in the
 * database. Both refuse a session that may not run conflict checks.
 */

const linkRowSchema = v.variant("accessible", [
  v.object({
    contact_id: resourceIdSchema("contact"),
    workspace_id: resourceIdSchema("workspace"),
    accessible: v.literal(true),
    relation: v.picklist(CONFLICT_RELATIONS),
    role: v.nullable(v.string()),
    matter_state: v.picklist(CONFLICT_MATTER_STATES),
    severity: v.picklist(CONFLICT_SEVERITIES),
  }),
  v.object({
    contact_id: resourceIdSchema("contact"),
    workspace_id: resourceIdSchema("workspace"),
    accessible: v.literal(false),
    relation: v.null(),
    role: v.null(),
    matter_state: v.null(),
    severity: v.picklist(CONFLICT_SEVERITIES),
  }),
]);

/** Every matter link of the given contacts, classified for `partyRole`. */
export const readConflictContactLinks = async ({
  tx,
  organizationId,
  partyRole,
  contactIds,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  partyRole: ConflictPartyRole;
  contactIds: readonly SafeId<"contact">[];
}): Promise<Map<SafeId<"contact">, StoredConflictLink[]>> => {
  const links = new Map<SafeId<"contact">, StoredConflictLink[]>();
  if (contactIds.length === 0) {
    return links;
  }
  const rows = await tx.execute(sql`
    SELECT contact_id, workspace_id, accessible, relation, role, matter_state, severity
    FROM public.stella_conflict_contact_links(
      ${organizationId},
      ${partyRole},
      ${typedPgArray(contactIds, "uuid")}
    )
    ORDER BY contact_id, workspace_id
  `);
  for (const raw of rows) {
    const parsed = v.safeParse(linkRowSchema, raw);
    if (!parsed.success) {
      return panic("The conflict link routine returned an unexpected row");
    }
    const row = parsed.output;
    const link: StoredConflictLink = row.accessible
      ? {
          access: "visible",
          workspaceId: row.workspace_id,
          relation: row.relation,
          role: row.role,
          state: row.matter_state,
          severity: row.severity,
        }
      : {
          access: "walled",
          workspaceId: row.workspace_id,
          severity: row.severity,
        };
    links.set(row.contact_id, [...(links.get(row.contact_id) ?? []), link]);
  }
  return links;
};

const matterRowSchema = v.object({
  workspace_id: resourceIdSchema("workspace"),
  accessible: v.boolean(),
  contact_user_id: v.nullable(v.pipe(v.string(), v.minLength(1))),
});

export type ConflictMatterAccess = {
  accessible: boolean;
  /** Whom to ask about a matter the reader may not open; null means an administrator. */
  contactUserId: SafeId<"user"> | null;
};

/**
 * For matters a stored check recorded: which still exist, which the reader
 * may open, and whom to ask about the rest. A matter missing from the map no
 * longer exists.
 */
export const readConflictMatterAccess = async ({
  tx,
  organizationId,
  workspaceIds,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceIds: readonly SafeId<"workspace">[];
}): Promise<Map<SafeId<"workspace">, ConflictMatterAccess>> => {
  const access = new Map<SafeId<"workspace">, ConflictMatterAccess>();
  if (workspaceIds.length === 0) {
    return access;
  }
  const rows = await tx.execute(sql`
    SELECT workspace_id, accessible, contact_user_id
    FROM public.stella_conflict_matter_contacts(
      ${organizationId},
      ${typedPgArray(workspaceIds, "uuid")}
    )
  `);
  for (const raw of rows) {
    const parsed = v.safeParse(matterRowSchema, raw);
    if (!parsed.success) {
      return panic("The conflict matter routine returned an unexpected row");
    }
    access.set(parsed.output.workspace_id, {
      accessible: parsed.output.accessible,
      contactUserId:
        parsed.output.accessible || parsed.output.contact_user_id === null
          ? null
          : brandPersistedUserId(parsed.output.contact_user_id),
    });
  }
  return access;
};
