import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import { MCP_ALL_RESOURCE_SCOPES } from "@/api/mcp/constants";
import { loadAccessibleMcpWorkspaces } from "@/api/mcp/context";
import type { McpRequestContext } from "@/api/mcp/context";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { filterUsableMcpWorkspaces } from "@/api/mcp/workspace-session-scope";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * Every registered MCP tool runs its real handler against a real database and
 * its output goes through the tool's advertised output contract, exactly as
 * an MCP client call does. No output fixture stands in for a handler: a field
 * a handler starts returning without a projection decision fails here.
 *
 * Tools whose data lives outside the database (the search index, object
 * storage, the public corpus, upstream registries, a model provider) are
 * listed in `TOOL_COVERAGE` with the reason; the map is total over the
 * registry, so a new tool cannot land without a decision.
 */

setDefaultTimeout(120_000);

type DefaultMcpToolName = (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number]["name"];

const COVERAGE = { run: "run", excluded: "excluded" } as const;

type ToolCoverage =
  | { readonly type: typeof COVERAGE.run }
  | { readonly type: typeof COVERAGE.excluded; readonly reason: string };

const RUN = { type: COVERAGE.run } as const;

const excluded = (reason: string) =>
  ({ type: COVERAGE.excluded, reason }) as const;

const SEARCH_INDEX =
  "reads the search index, which this database does not hold";
const PUBLIC_CORPUS =
  "reads the public legal corpus (case law, legislation), not seeded here";
const UPSTREAM = "calls an upstream publisher or registry over HTTP";
const OBJECT_STORAGE = "reads or writes DOCX files in object storage";

const TOOL_COVERAGE = {
  search: excluded(SEARCH_INDEX),
  fetch: excluded(SEARCH_INDEX),
  list_matters: RUN,
  read_contact: RUN,
  read_content_across_matters: excluded(SEARCH_INDEX),
  search_across_matters: excluded(SEARCH_INDEX),
  search_case_law: excluded(PUBLIC_CORPUS),
  resolve_case_law_decision: excluded(PUBLIC_CORPUS),
  resolve_law_citation: excluded(PUBLIC_CORPUS),
  case_law_coverage: excluded(PUBLIC_CORPUS),
  read_case_law_decision: excluded(PUBLIC_CORPUS),
  read_case_law_citations: excluded(PUBLIC_CORPUS),
  open_case_law_decision: excluded(PUBLIC_CORPUS),
  read_case_law_decision_blocks: excluded(PUBLIC_CORPUS),
  preview_cited_provision: excluded(PUBLIC_CORPUS),
  set_practice_jurisdictions: RUN,
  search_legislation: excluded(PUBLIC_CORPUS),
  read_statute: excluded(PUBLIC_CORPUS),
  read_statute_provisions: excluded(PUBLIC_CORPUS),
  read_provision_history: excluded(PUBLIC_CORPUS),
  search_boe_legislation: excluded(UPSTREAM),
  list_templates: RUN,
  create_template: excluded(OBJECT_STORAGE),
  configure_template_fields: excluded(OBJECT_STORAGE),
  fill_template: excluded(OBJECT_STORAGE),
  preview_template_conditions: excluded(
    "asks a model provider to decide AI conditions",
  ),
  save_filled_template: excluded(OBJECT_STORAGE),
  list_documents: RUN,
  read_document: RUN,
  save_document: RUN,
  delete_document: RUN,
  set_field_value: excluded(
    "a fresh matter holds only the file property, which set_field_value refuses; a text property is created through write_capability",
  ),
  list_properties: RUN,
  compare_documents: excluded(OBJECT_STORAGE),
  prepare_file_comparison: excluded(OBJECT_STORAGE),
  prepare_file_comparison_from_links: excluded(UPSTREAM),
  open_file_comparison: excluded(OBJECT_STORAGE),
  open_document_version_upload: excluded(OBJECT_STORAGE),
  upload_document_version: excluded(OBJECT_STORAGE),
  save_matter: RUN,
  delete_matter: excluded(
    "deletes in the root-pool owner transaction (lib/workspace-deletion.ts), which the hermetic test database does not serve",
  ),
  save_contact: RUN,
  delete_contact: RUN,
  link_matter_contact: RUN,
  list_contacts: RUN,
  save_task: RUN,
  delete_task: RUN,
  list_tasks: RUN,
  lookup_business_registry: excluded(UPSTREAM),
  check_counterparty: excluded(UPSTREAM),
  list_clauses: RUN,
  save_clause: RUN,
  delete_clause: RUN,
  list_playbooks: RUN,
  save_playbook: RUN,
  run_playbook: excluded("starts a model-provider workflow"),
  list_reader_annotations: excluded(PUBLIC_CORPUS),
  create_reader_annotation: excluded(PUBLIC_CORPUS),
  update_reader_annotation: excluded(
    "needs an annotation, which only create_reader_annotation (public corpus) makes",
  ),
  delete_reader_annotation: excluded(
    "needs an annotation, which only create_reader_annotation (public corpus) makes",
  ),
  list_time_entries: RUN,
  save_time_entry: RUN,
  delete_time_entry: RUN,
  resolve_rate: RUN,
  list_invoices: RUN,
  get_usage: RUN,
  list_audit_log: RUN,
  manage_organization: RUN,
  prepare_feedback: RUN,
  submit_feedback: excluded("delivers the report to an external tracker"),
  list_capabilities: RUN,
  describe_capability: RUN,
  read_capability: excluded(
    "dispatches an HTTP request to the API router, which this test does not serve",
  ),
  write_capability: excluded(
    "dispatches an HTTP request to the API router, which this test does not serve",
  ),
} as const satisfies Record<DefaultMcpToolName, ToolCoverage>;

type RunToolName = {
  [TName in keyof typeof TOOL_COVERAGE]: (typeof TOOL_COVERAGE)[TName] extends {
    type: typeof COVERAGE.run;
  }
    ? TName
    : never;
}[keyof typeof TOOL_COVERAGE];

/** Ids earlier calls created, read by later ones. */
type Seeded = {
  userId: SafeId<"user">;
  matterId?: string;
  contactId?: string;
  taskId?: string;
  timeEntryId?: string;
  clauseId?: string;
  playbookId?: string;
  documentId?: string;
};

type Step = {
  readonly tool: RunToolName;
  readonly args: (seeded: Seeded) => Record<string, unknown>;
  readonly capture?: (payload: Record<string, unknown>, seeded: Seeded) => void;
};

const required = (value: string | undefined, name: string): string => {
  if (value === undefined) {
    throw new Error(`An earlier step did not create ${name}`);
  }
  return value;
};

const idAt = (payload: Record<string, unknown>, key: string): string => {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new TypeError(`Expected a string id at ${key}`);
  }
  return value;
};

const today = (): string => Temporal.Now.plainDateISO("UTC").toString();

// Ordered: creates first, reads of what they made, deletes last.
const STEPS: readonly Step[] = [
  {
    tool: "save_contact",
    args: () => ({ type: "organization", display_name: "Acme s.r.o." }),
    capture: (payload, seeded) => {
      seeded.contactId = idAt(payload, "contactId");
    },
  },
  {
    tool: "save_matter",
    args: () => ({ name: "Lease review" }),
    capture: (payload, seeded) => {
      seeded.matterId = idAt(payload, "matterId");
    },
  },
  { tool: "list_matters", args: () => ({}) },
  {
    tool: "read_contact",
    args: (s) => ({ contact_id: required(s.contactId, "contact") }),
  },
  { tool: "list_contacts", args: () => ({}) },
  {
    tool: "link_matter_contact",
    args: (s) => ({
      matter_id: required(s.matterId, "matter"),
      contact_id: required(s.contactId, "contact"),
      role: "opposing_party",
    }),
  },
  {
    tool: "save_task",
    args: (s) => ({
      matter_id: required(s.matterId, "matter"),
      name: "Draft the notice",
    }),
    capture: (payload, seeded) => {
      seeded.taskId = idAt(payload, "taskId");
    },
  },
  {
    tool: "list_tasks",
    args: (s) => ({ matter_id: required(s.matterId, "matter") }),
  },
  {
    tool: "save_time_entry",
    args: (s) => ({
      matter_id: required(s.matterId, "matter"),
      date_worked: today(),
      timezone_id: "UTC",
      duration_minutes: 30,
      narrative: "Reviewed the lease",
      // A billable entry needs a configured rate, which a new matter lacks.
      billable: false,
    }),
    capture: (payload, seeded) => {
      seeded.timeEntryId = idAt(payload, "timeEntryId");
    },
  },
  {
    tool: "list_time_entries",
    args: (s) => ({ matter_id: required(s.matterId, "matter") }),
  },
  {
    tool: "resolve_rate",
    args: (s) => ({
      matter_id: required(s.matterId, "matter"),
      user_id: s.userId,
      date: today(),
    }),
  },
  {
    tool: "list_invoices",
    args: (s) => ({ matter_id: required(s.matterId, "matter") }),
  },
  { tool: "get_usage", args: () => ({}) },
  {
    tool: "save_clause",
    args: () => ({
      title: "Governing law",
      body: [{ text: "Czech law governs this agreement." }],
    }),
    capture: (payload, seeded) => {
      seeded.clauseId = idAt(payload, "clauseId");
    },
  },
  { tool: "list_clauses", args: () => ({}) },
  {
    tool: "save_playbook",
    args: () => ({ name: "Lease playbook" }),
    capture: (payload, seeded) => {
      seeded.playbookId = idAt(payload, "playbookId");
    },
  },
  { tool: "list_playbooks", args: () => ({}) },
  {
    tool: "save_document",
    args: (s) => ({ matter_id: required(s.matterId, "matter"), name: "Lease" }),
    capture: (payload, seeded) => {
      seeded.documentId = idAt(payload, "entityId");
    },
  },
  {
    tool: "list_documents",
    args: (s) => ({ matter_id: required(s.matterId, "matter") }),
  },
  {
    tool: "read_document",
    args: (s) => ({ entity_id: required(s.documentId, "document") }),
  },
  {
    tool: "list_properties",
    args: (s) => ({ matter_id: required(s.matterId, "matter") }),
  },
  { tool: "list_templates", args: () => ({}) },
  {
    tool: "set_practice_jurisdictions",
    args: () => ({ jurisdictions: [{ country_code: "CZ", is_primary: true }] }),
  },
  {
    tool: "manage_organization",
    args: () => ({
      action: "update_org_settings",
      time_narrative_required: false,
    }),
  },
  {
    tool: "prepare_feedback",
    args: () => ({
      kind: "bug",
      area: "matters",
      title: "Matter list",
      what_happened: "The list was empty.",
    }),
  },
  { tool: "list_capabilities", args: () => ({}) },
  {
    tool: "describe_capability",
    args: () => ({ capability: "properties.create" }),
  },
  { tool: "list_audit_log", args: () => ({}) },
  {
    tool: "delete_time_entry",
    args: (s) => ({
      time_entry_id: required(s.timeEntryId, "time entry"),
      confirm: true,
    }),
  },
  {
    tool: "delete_task",
    args: (s) => ({ task_id: required(s.taskId, "task"), confirm: true }),
  },
  {
    tool: "delete_document",
    args: (s) => ({
      entity_id: required(s.documentId, "document"),
      confirm: true,
    }),
  },
  {
    tool: "delete_clause",
    args: (s) => ({ clause_id: required(s.clauseId, "clause"), confirm: true }),
  },
  {
    tool: "delete_contact",
    args: (s) => ({
      contact_id: required(s.contactId, "contact"),
      confirm: true,
    }),
  },
];

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

type Caller = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const createOrganization = async (): Promise<Caller> => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await testDb
    .insert(user)
    .values({ id: userId, name: "Owner", email: `${userId}@test.local` });
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Firm",
    slug: `firm-${organizationId}`,
    createdAt: new Date(),
  });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  return { organizationId, userId };
};

/** Resolved per call, as one MCP request does: matters change between steps. */
const requestContext = async ({
  organizationId,
  userId,
}: Caller): Promise<McpRequestContext> => {
  const identity = { organizationId, serverValidatedWorkspaceIds: [], userId };
  const scopedDb = asTestRaw<ScopedDb>(
    createMembershipScopedDb(testDb, identity),
  );
  const safeDb = asTestRaw<SafeDb>(createMembershipSafeDb(testDb, identity));
  const usable = filterUsableMcpWorkspaces({
    accessibleWorkspaces: await loadAccessibleMcpWorkspaces({
      organizationId,
      scopedDb,
    }),
    tokenWorkspaceIds: undefined,
  });
  const workspaceIds = usable.map((workspace) => workspace.id);
  return asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: workspaceIds,
    accessibleWorkspaceIdSet: new Set(workspaceIds),
    accessibleWorkspaceStatusById: new Map(
      usable.map((workspace) => [workspace.id, workspace.status]),
    ),
    accessibleWorkspaces: usable,
    grantedScopes: MCP_ALL_RESOURCE_SCOPES,
    memberRole: "owner",
    organizationId,
    recordAuditEvent: async () => undefined,
    safeDb,
    scopedDb,
    toolConfirmation: TOOL_CONFIRMATION.caller,
    userId,
    userEmail: "owner@example.test",
    // Billing tools are enrolment-gated; the owner is enrolled so every
    // runnable tool is exercised.
    featureAccessSnapshot: enrolledTimeBillingSnapshot({
      organizationId,
      userId,
    }),
  });
};

const textOf = (result: Awaited<ReturnType<typeof handleMcpToolCall>>) => {
  const item = result.content.at(0);
  return item?.type === "text" ? item.text : "";
};

describe("every MCP tool's real output passes its output contract", () => {
  test("the coverage map and the steps agree", () => {
    const run = Object.entries(TOOL_COVERAGE)
      .filter(([, coverage]) => coverage.type === COVERAGE.run)
      .map(([name]) => name)
      .toSorted();
    expect(STEPS.map((step): string => step.tool).toSorted()).toEqual(run);
  });

  test("every registered tool has a coverage decision", () => {
    expect(
      DEFAULT_MCP_TOOL_DEFINITIONS.map((tool): string => tool.name).toSorted(),
    ).toEqual(Object.keys(TOOL_COVERAGE).toSorted());
  });

  test("a seeded organization drives each runnable tool", async () => {
    const caller = await createOrganization();
    const seeded: Seeded = { userId: caller.userId };
    for (const step of STEPS) {
      const result = await handleMcpToolCall({
        args: step.args(seeded),
        context: await requestContext(caller),
        toolName: step.tool,
      });
      // The tool name and response text name the failing call.
      expect({ tool: step.tool, isError: result.isError === true }).toEqual({
        tool: step.tool,
        isError: false,
        ...(result.isError === true ? { response: textOf(result) } : {}),
      });
      const { structuredContent } = result;
      expect(isRecord(structuredContent)).toBe(true);
      if (step.capture !== undefined && isRecord(structuredContent)) {
        step.capture(structuredContent, seeded);
      }
    }
  });
});
