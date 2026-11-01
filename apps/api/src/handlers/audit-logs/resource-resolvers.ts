import { and, eq, inArray } from "drizzle-orm";

import type { AuditResourceKind } from "@stll/api-contract/audit-log";

import { workspaceIdCheck } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import {
  contacts,
  entities,
  invoices,
  templates,
  userFiles,
  workspaces,
} from "@/api/db/schema";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  brandPersistedContactId,
  brandPersistedEntityId,
  brandPersistedInvoiceId,
  brandPersistedTemplateId,
  brandPersistedUserFileId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

type ResolveOptions = {
  tx: Transaction;
  ids: string[];
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
};

type ResourceNames = Map<string, string | null>;
type Resolver = (options: ResolveOptions) => Promise<ResourceNames>;
type Resolution = Resolver | { type: "unresolvable"; reason: string };

const toNames = (rows: { id: string; name: string | null }[]) =>
  new Map(rows.map(({ id, name }) => [id, name]));

const resolveWorkspace: Resolver = async (options) => {
  const { tx, ids, organizationId } = options;
  return toNames(
    await tx
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.organizationId, organizationId),
          inArray(workspaces.id, ids.map(brandPersistedWorkspaceId)),
          workspaceIdCheck,
        ),
      ),
  );
};
const resolveContact: Resolver = async (options) => {
  const { tx, ids, organizationId } = options;
  return toNames(
    await tx
      .select({ id: contacts.id, name: contacts.displayName })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          inArray(contacts.id, ids.map(brandPersistedContactId)),
        ),
      ),
  );
};
const resolveInvoice: Resolver = async (options) => {
  const { tx, ids, organizationId } = options;
  return toNames(
    await tx
      .select({ id: invoices.id, name: invoices.invoiceNumber })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          inArray(invoices.id, ids.map(brandPersistedInvoiceId)),
        ),
      ),
  );
};
const resolveEntity: Resolver = async (options) => {
  const { tx, ids } = options;
  return toNames(
    await tx
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(
        and(
          inArray(entities.id, ids.map(brandPersistedEntityId)),
          workspaceIdCheck,
        ),
      ),
  );
};
const resolveTemplate: Resolver = async (options) => {
  const { tx, ids, organizationId } = options;
  return toNames(
    await tx
      .select({ id: templates.id, name: templates.name })
      .from(templates)
      .where(
        and(
          eq(templates.organizationId, organizationId),
          inArray(templates.id, ids.map(brandPersistedTemplateId)),
        ),
      ),
  );
};
const resolveUserFile: Resolver = async (options) => {
  const { tx, ids, userId } = options;
  if (userId === null) {
    return new Map();
  }
  return toNames(
    await tx
      .select({ id: userFiles.id, name: userFiles.fileName })
      .from(userFiles)
      .where(
        and(
          eq(userFiles.userId, userId),
          inArray(userFiles.id, ids.map(brandPersistedUserFileId)),
        ),
      ),
  );
};

const AUDIT_RESOURCE_RESOLVERS = {
  [AUDIT_RESOURCE_TYPE.MCP_WEB_HANDOFF]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.SERVICE_OAUTH_CLIENT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.LEGAL_RESOLVE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.AUDIT_LOG]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL_COMMENT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.AI_MEMORY]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.ANNOUNCEMENT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.BILLING_CODE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CASE_LAW_DECISION_ANNOTATION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CASE_LAW_READER_ANSWER]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CASE_LAW_RESEARCH_COLUMN]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CHAT_FILE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CHAT_MESSAGE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CHAT_THREAD]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CHAT_TOOL_EXECUTION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CHAT_TOOL_GRANT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CLAUSE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CLAUSE_CATEGORY]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CLAUSE_TEMPLATE_LINK]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CLAUSE_VARIANT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CONTACT]: resolveContact,
  [AUDIT_RESOURCE_TYPE.CONTACT_DIRECTORY]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.CORRESPONDENCE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.DOCUMENT_ANNOTATION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.DOCUMENT_TYPE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.USAGE_EVENT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.USAGE_PROVIDER_EVENT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.BILINGUAL_TRANSLATION_RUN]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.DOCUMENT_TRANSLATION_RUN]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.ENTITY]: resolveEntity,
  [AUDIT_RESOURCE_TYPE.ENTITY_VERSION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.EXPENSE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.FEEDBACK_REPORT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.FIELD]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.FILE_COMPARISON]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.FLOW_DEFINITION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.FLOW_RUN]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.SIGNAL]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.INVOICE]: resolveInvoice,
  [AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.MACHINE_API_KEY]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_ITEM]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.MCP_CONNECTION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.MCP_GATEWAY_TOOL]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.ORGANIZATION_ACCESS_STATE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.PLAYBOOK]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.PROPERTY]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.RATE_ENTRY]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.REPORT_EXPORT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.RATE_TABLE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.SAVED_SEARCH]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.SEARCH_HISTORY]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.SELLER_PROFILE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.SAVED_TIME_NARRATIVE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.VAT_RATE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.NUMBER_SERIES]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.STATUTE_ANNOTATION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.STYLE_SET]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.TEMPLATE]: resolveTemplate,
  [AUDIT_RESOURCE_TYPE.TEMPLATE_LOOKUP_FORMAT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.TIME_ENTRY]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.TIME_DAILY_TARGET]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.TIME_TIMER]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.USER_FILE]: resolveUserFile,
  [AUDIT_RESOURCE_TYPE.VIEW]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.VIEW_TEMPLATE]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.WORKSPACE]: resolveWorkspace,
  [AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
  [AUDIT_RESOURCE_TYPE.WORK_OBLIGATION]: {
    type: "unresolvable",
    reason: "No canonical user-facing name source",
  },
} as const satisfies Record<AuditResourceKind, Resolution>;

export const resolveAuditResourceNames = async ({
  tx,
  rows,
  organizationId,
  userId,
}: {
  tx: Transaction;
  rows: { resourceType: AuditResourceKind; resourceId: string }[];
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
}) => {
  const resolved = new Map<AuditResourceKind, ResourceNames>();
  for (const kind of Object.values(AUDIT_RESOURCE_TYPE)) {
    const resolver = AUDIT_RESOURCE_RESOLVERS[kind];
    if (typeof resolver !== "function") {
      continue;
    }
    const ids = [
      ...new Set(
        rows
          .filter((row) => row.resourceType === kind)
          .map((row) => row.resourceId),
      ),
    ];
    if (ids.length === 0) {
      continue;
    }
    // db-await-in-loop: one batched read per resource kind on the page, bounded by the fixed kind set
    resolved.set(kind, await resolver({ tx, ids, organizationId, userId }));
  }
  return resolved;
};
