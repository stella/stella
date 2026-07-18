/**
 * Resolve the {@link BindingContext} for a fill: scan the manifest for which
 * source kinds, party roles, and attorney refs its bound fields actually
 * reference, then fetch only those records. A manifest with no bound fields
 * fires no query; one binding only the client fetches the matter + client in a
 * single round-trip and nothing else.
 *
 * Attorneys are users (org members), not contacts: the responsible/originating
 * attorney come from the client contact, the lead from the matter, and each id
 * is resolved against the `user` table. RLS only exposes org members and the
 * current user, so a removed attorney resolves to null and its field is left
 * unfilled (handled like a null client).
 */

import type { ScopedDb } from "@/api/db/safe-db";
import type {
  BankAccount,
  BillingAddress,
  ContactAddress,
  ContactEmail,
  ContactPersistedMetadata,
  ContactPhone,
} from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

import type {
  BindingContext,
  ContactSourceRecord,
  MatterSourceRecord,
  UserSourceRecord,
} from "./apply-source-fields";
import { EMPTY_BINDING_CONTEXT } from "./apply-source-fields";
import type { AttorneyRef, WorkspaceContactRole } from "./binding-sources";
import type { FieldMeta } from "./types";

/** The contact columns mapped into a {@link ContactSourceRecord}; shared by the
 *  client and party projections. */
const CONTACT_SOURCE_COLUMNS = {
  type: true,
  displayName: true,
  firstName: true,
  lastName: true,
  organizationName: true,
  emails: true,
  phones: true,
  addresses: true,
  billingAddress: true,
  registrationNumber: true,
  taxId: true,
  bankAccounts: true,
  metadata: true,
} as const;

/** A contact row projected through {@link CONTACT_SOURCE_COLUMNS}. */
type ContactRow = {
  type: "person" | "organization";
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  emails: ContactEmail[] | null;
  phones: ContactPhone[] | null;
  addresses: ContactAddress[] | null;
  billingAddress: BillingAddress | null;
  registrationNumber: string | null;
  taxId: string | null;
  bankAccounts: BankAccount[] | null;
  metadata: ContactPersistedMetadata | null;
};

const toContactSourceRecord = (row: ContactRow): ContactSourceRecord => ({
  type: row.type,
  displayName: row.displayName,
  firstName: row.firstName,
  lastName: row.lastName,
  organizationName: row.organizationName,
  emails: row.emails,
  phones: row.phones,
  addresses: row.addresses,
  billingAddress: row.billingAddress,
  registrationNumber: row.registrationNumber,
  taxId: row.taxId,
  bankAccounts: row.bankAccounts,
  dataBoxes: row.metadata?.dataBoxes ?? null,
});

/** The user columns mapped into a {@link UserSourceRecord} (an attorney). */
const USER_SOURCE_COLUMNS = {
  name: true,
  email: true,
  preferredName: true,
} as const;

type UserRow = { name: string; email: string; preferredName: string | null };

const toUserSourceRecord = (row: UserRow): UserSourceRecord => ({
  name: row.name,
  email: row.email,
  preferredName: row.preferredName,
});

type ReferencedSources = {
  client: boolean;
  matter: boolean;
  firm: boolean;
  partyRoles: Set<WorkspaceContactRole>;
  attorneyRefs: Set<AttorneyRef>;
};

const scanReferencedSources = (
  fields: readonly FieldMeta[],
): ReferencedSources => {
  const referenced: ReferencedSources = {
    client: false,
    matter: false,
    firm: false,
    partyRoles: new Set(),
    attorneyRefs: new Set(),
  };
  for (const field of fields) {
    const { source } = field;
    if (source === undefined) {
      continue;
    }
    switch (source.kind) {
      case "contact":
        referenced.client = true;
        break;
      case "matter":
        referenced.matter = true;
        break;
      case "firm":
        referenced.firm = true;
        break;
      case "party":
        referenced.partyRoles.add(source.role);
        break;
      case "attorney":
        referenced.attorneyRefs.add(source.ref);
        break;
      default: {
        const exhaustive: never = source;
        referenced.client = exhaustive;
      }
    }
  }
  return referenced;
};

export type BuildBindingContextOptions = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  manifest: { fields: FieldMeta[] };
};

/** The matter (workspace) + client read in one round-trip: the matter fields,
 *  the lead-user id, and the client contact with its responsible / originating
 *  attorney users (resolved through the relation, never raw owner ids). */
type WorkspaceResolution = {
  matter: MatterSourceRecord | null;
  client: ContactSourceRecord | null;
  responsibleAttorney: UserSourceRecord | null;
  originatingAttorney: UserSourceRecord | null;
  leadUserId: string | null;
};

const fetchWorkspace = async ({
  scopedDb,
  workspaceId,
  referenced,
}: {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  referenced: ReferencedSources;
}): Promise<WorkspaceResolution> => {
  const workspace = await scopedDb((tx) =>
    tx.query.workspaces.findFirst({
      where: { id: { eq: workspaceId } },
      columns: {
        name: true,
        reference: true,
        billingReference: true,
        status: true,
        leadUserId: true,
      },
      with: {
        client: {
          columns: CONTACT_SOURCE_COLUMNS,
          // Resolve the responsible / originating attorneys through the
          // relation (their `user` row) so no raw owner id is read.
          with: {
            responsibleAttorney: { columns: USER_SOURCE_COLUMNS },
            originatingAttorney: { columns: USER_SOURCE_COLUMNS },
          },
        },
      },
    }),
  );

  if (!workspace) {
    return {
      matter: null,
      client: null,
      responsibleAttorney: null,
      originatingAttorney: null,
      leadUserId: null,
    };
  }

  const client = workspace.client;
  return {
    matter: referenced.matter
      ? {
          name: workspace.name,
          reference: workspace.reference,
          billingReference: workspace.billingReference,
          status: workspace.status,
        }
      : null,
    client: referenced.client && client ? toContactSourceRecord(client) : null,
    responsibleAttorney: client?.responsibleAttorney
      ? toUserSourceRecord(client.responsibleAttorney)
      : null,
    originatingAttorney: client?.originatingAttorney
      ? toUserSourceRecord(client.originatingAttorney)
      : null,
    leadUserId: workspace.leadUserId ?? null,
  };
};

const fetchParties = async ({
  scopedDb,
  workspaceId,
  roles,
}: {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  roles: ReadonlySet<WorkspaceContactRole>;
}): Promise<Partial<Record<WorkspaceContactRole, ContactSourceRecord>>> => {
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- parallel fan-out (Promise.all) bounded by the WORKSPACE_CONTACT_ROLES enum (<=9), not tenant row volume; one small read per referenced role
  const entries = await Promise.all(
    [...roles].map(async (role) => {
      // Different contacts can share a role; the primary (else earliest) one is
      // the deterministic pick for a scalar party binding.
      const link = await scopedDb((tx) =>
        tx.query.workspaceContacts.findFirst({
          where: { workspaceId: { eq: workspaceId }, role: { eq: role } },
          orderBy: { isPrimary: "desc", createdAt: "asc" },
          columns: {},
          with: { contact: { columns: CONTACT_SOURCE_COLUMNS } },
        }),
      );
      const contact = link?.contact;
      return contact === undefined || contact === null
        ? null
        : ([role, toContactSourceRecord(contact)] as const);
    }),
  );

  const parties: Partial<Record<WorkspaceContactRole, ContactSourceRecord>> =
    {};
  for (const entry of entries) {
    if (entry !== null) {
      parties[entry[0]] = entry[1];
    }
  }
  return parties;
};

const fetchAttorneys = async ({
  scopedDb,
  refs,
  workspace,
}: {
  scopedDb: ScopedDb;
  refs: ReadonlySet<AttorneyRef>;
  workspace: WorkspaceResolution;
}): Promise<Partial<Record<AttorneyRef, UserSourceRecord>>> => {
  const attorneys: Partial<Record<AttorneyRef, UserSourceRecord>> = {};

  // Responsible / originating were already resolved with the client via the
  // contact relation; only the matter's lead (no relation) needs its own read.
  if (refs.has("responsible") && workspace.responsibleAttorney !== null) {
    attorneys.responsible = workspace.responsibleAttorney;
  }
  if (refs.has("originating") && workspace.originatingAttorney !== null) {
    attorneys.originating = workspace.originatingAttorney;
  }

  const leadUserId = workspace.leadUserId;
  if (refs.has("lead") && leadUserId !== null) {
    const user = await scopedDb((tx) =>
      tx.query.user.findFirst({
        where: { id: { eq: leadUserId } },
        columns: USER_SOURCE_COLUMNS,
      }),
    );
    if (user) {
      attorneys.lead = toUserSourceRecord(user);
    }
  }

  return attorneys;
};

const fetchFirm = async ({
  scopedDb,
  organizationId,
}: {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
}): Promise<BindingContext["firm"]> => {
  const firm = await scopedDb((tx) =>
    tx.query.organization.findFirst({
      where: { id: { eq: organizationId } },
      columns: { name: true },
    }),
  );
  return firm ? { name: firm.name } : null;
};

export const buildBindingContext = async ({
  scopedDb,
  organizationId,
  workspaceId,
  manifest,
}: BuildBindingContextOptions): Promise<BindingContext> => {
  const referenced = scanReferencedSources(manifest.fields);

  // The workspace read backs the matter, the client, and the responsible /
  // originating / lead attorney ids, so any of those references it.
  const needWorkspace =
    referenced.matter || referenced.client || referenced.attorneyRefs.size > 0;

  const [workspace, parties, firm] = await Promise.all([
    needWorkspace
      ? fetchWorkspace({ scopedDb, workspaceId, referenced })
      : null,
    referenced.partyRoles.size > 0
      ? fetchParties({ scopedDb, workspaceId, roles: referenced.partyRoles })
      : {},
    referenced.firm ? fetchFirm({ scopedDb, organizationId }) : null,
  ]);

  const attorneys =
    workspace !== null && referenced.attorneyRefs.size > 0
      ? await fetchAttorneys({
          scopedDb,
          refs: referenced.attorneyRefs,
          workspace,
        })
      : {};

  return {
    client: workspace?.client ?? EMPTY_BINDING_CONTEXT.client,
    parties,
    matter: workspace?.matter ?? EMPTY_BINDING_CONTEXT.matter,
    attorneys,
    firm,
  };
};
