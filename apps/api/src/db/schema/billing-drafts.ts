import { billingGuidelinePolicies } from "@/api/db/rls";

import {
  p,
  safeOrganizationId,
  safeUuid,
  organization,
  user,
  timestamptz,
  userPolicies,
  sql,
} from "./common";
import { contacts } from "./contacts";
import { agentSkillResources } from "./skills";

export const billingDraftUserSettings = p.pgTable(
  "billing_draft_user_settings",
  {
    userId: p
      .text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    consentAt: timestamptz("consent_at"),
    preference: p.varchar("preference", { length: 2000 }),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  () => [...userPolicies()],
);

export const billingGuidelineFiles = p.pgTable(
  "billing_guideline_files",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    resourceId: safeUuid<"agentSkillResource">("resource_id")
      .notNull()
      .references(() => agentSkillResources.id, { onDelete: "cascade" }),
    clientId: safeUuid<"contact">("client_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
  },
  (table) => [
    p
      .uniqueIndex("billing_guideline_files_firm_uidx")
      .on(table.organizationId)
      .where(sql`${table.clientId} IS NULL`),
    p
      .uniqueIndex("billing_guideline_files_client_resource_uidx")
      .on(table.organizationId, table.clientId, table.resourceId)
      .where(sql`${table.clientId} IS NOT NULL`),
    p
      .index("billing_guideline_files_org_client_idx")
      .on(table.organizationId, table.clientId),
    ...billingGuidelinePolicies(),
  ],
);
