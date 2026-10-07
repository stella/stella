import { denyStellaAccessPolicies } from "@/api/db/rls";

import {
  organization,
  p,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
} from "./common";

const ownsUserAcceptances = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.user_professional_use_acceptances'::regclass)`;

/**
 * A person's acceptance of the professional-use statement: by creating the
 * account where the statement is shown, or on the prompt at the first
 * interactive sign-in of an account created elsewhere. Written once on the
 * owner connection; the request role has no access.
 */
export const userProfessionalUseAcceptances = p.pgTable(
  "user_professional_use_acceptances",
  {
    userId: p
      .text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    statementVersion: p.text("statement_version").notNull(),
    termsVersion: p.text("terms_version").notNull(),
    acceptedAt: timestamptz("accepted_at").notNull().defaultNow(),
  },
  () => [
    p.pgPolicy("user_professional_use_acceptances_owner_access", {
      for: "all",
      to: "public",
      using: ownsUserAcceptances,
      withCheck: ownsUserAcceptances,
    }),
    ...denyStellaAccessPolicies(),
  ],
);

const ownsOrganizationAcceptances = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_professional_use_acceptances'::regclass)`;

/**
 * The professional-use acceptance an organization carries, with the account
 * whose acceptance it is: its creator's at creation, or, for an organization
 * created before its creator accepted, the first owner to accept. Written
 * once on the owner connection; the request role has no access.
 */
export const organizationProfessionalUseAcceptances = p.pgTable(
  "organization_professional_use_acceptances",
  {
    organizationId: safeOrganizationId("organization_id").primaryKey(),
    acceptedByUserId: p.text("accepted_by_user_id"),
    statementVersion: p.text("statement_version").notNull(),
    termsVersion: p.text("terms_version").notNull(),
    acceptedAt: timestamptz("accepted_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.organizationId],
        foreignColumns: [organization.id],
        name: "organization_professional_use_acceptances_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.acceptedByUserId],
        foreignColumns: [user.id],
        name: "organization_professional_use_acceptances_user_fk",
      })
      .onDelete("set null"),
    p
      .index("organization_professional_use_acceptances_user_idx")
      .on(table.acceptedByUserId),
    p.pgPolicy("organization_professional_use_acceptances_owner_access", {
      for: "all",
      to: "public",
      using: ownsOrganizationAcceptances,
      withCheck: ownsOrganizationAcceptances,
    }),
    ...denyStellaAccessPolicies(),
  ],
);
