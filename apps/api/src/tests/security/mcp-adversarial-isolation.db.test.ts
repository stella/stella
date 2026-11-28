/**
 * Adversarial runtime isolation suite for the MCP tool surface
 * (`handleMcpToolCall`) running against a real PGlite database.
 *
 * Complements HTTP `cross-tenant-handlers.test.ts` and single-tenant
 * `tool-outputs.db.test.ts` by driving the production MCP request context
 * (`buildMcpSecurityPrincipal` -> `resolveMemberAuthorization`,
 * `createMcpOperationDatabases`, `loadAccessibleMcpWorkspaces`,
 * `filterUsableMcpWorkspaces`) across six
 * adversarial boundaries:
 *
 * 1. Cross-tenant (Org A owner -> Org B resources across all DB-backed tools)
 * 2. Intra-org ethical wall (Org A member -> unassigned restricted matter,
 *    including a multi-matter client invoice spanning accessible + restricted
 *    matters, plus cross-member time-entry privacy)
 * 3. Token-scoped workspace narrowing (`tokenWorkspaceIds` pinning an owner)
 * 4. Archived matter write freeze (reads allowed, every mutation rejected)
 * 5. External collaborator role boundary + entity-kind / matter-pairing guards
 * 6. Live revocation after matter-assignment removal
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  properties,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { MemberRole } from "@/api/lib/member-roles";
import { cents } from "@/api/lib/money";
import { isRecord } from "@/api/lib/type-guards";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { handleMcpToolCall } from "@/api/mcp/tools";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { enrolTimeBilling } from "@/api/tests/helpers/time-billing-enrolment";
import { buildMcpSecurityPrincipal } from "@/api/tests/security/principal";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: PGlite database bootstrap and multi-tenant MCP fixture seeding
setDefaultTimeout(60_000);

const FIXED_CREATED_AT = new Date("2026-06-15T10:00:00.000Z");
const FIXED_WORK_DATE = "2026-11-20";
const FIXED_INVOICE_DATE = "2026-10-01";
const SITE_NOTE_URL = "https://research.example.org/search";

type Actor = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  role: MemberRole;
  email: string;
};

type Fixture = {
  orgA: SafeId<"organization">;
  orgB: SafeId<"organization">;
  ownerA: Actor;
  memberA: Actor;
  collabA: Actor;
  ownerB: Actor;
  matterA_accessible: SafeId<"workspace">;
  matterA_restricted: SafeId<"workspace">;
  matterA_archived: SafeId<"workspace">;
  matterB: SafeId<"workspace">;
  docA1: SafeId<"entity">;
  docA_secret: SafeId<"entity">;
  docA_arch: SafeId<"entity">;
  docB: SafeId<"entity">;
  taskA1: SafeId<"entity">;
  taskA_secret: SafeId<"entity">;
  taskA_arch: SafeId<"entity">;
  taskB: SafeId<"entity">;
  propA1: SafeId<"property">;
  propA_secret: SafeId<"property">;
  propA_arch: SafeId<"property">;
  propB: SafeId<"property">;
  contactA: SafeId<"contact">;
  contactB: SafeId<"contact">;
  clauseA: SafeId<"clause">;
  clauseB: SafeId<"clause">;
  playbookA: SafeId<"playbook">;
  playbookB: SafeId<"playbook">;
  timeEntryA1_owner: SafeId<"timeEntry">;
  timeEntryA1_member: SafeId<"timeEntry">;
  timeEntryA_secret: SafeId<"timeEntry">;
  timeEntryA_arch: SafeId<"timeEntry">;
  timeEntryB: SafeId<"timeEntry">;
  invoiceA_secret: SafeId<"invoice">;
  invoiceA_spanning: SafeId<"invoice">;
  invoiceB: SafeId<"invoice">;
};

let testDb: TestDatabase;
let fx: Fixture;

const textOf = (result: Awaited<ReturnType<typeof handleMcpToolCall>>) => {
  const item = result.content.at(0);
  return item?.type === "text" ? item.text : "";
};

const safeIdFromStructured = <T extends SafeIdType>(
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
  key: string,
): SafeId<T> => {
  if (result.isError === true) {
    throw new TypeError(`Expected success, got error: ${textOf(result)}`);
  }
  const structured = result.structuredContent;
  if (!isRecord(structured) || typeof structured[key] !== "string") {
    throw new TypeError(`Missing string key "${key}" in structuredContent`);
  }
  return toSafeId<T>(structured[key]);
};

const buildContext = async (
  actor: Actor,
  options?: {
    tokenWorkspaceIds?: readonly SafeId<"workspace">[];
  },
) =>
  await buildMcpSecurityPrincipal({
    db: testDb,
    organizationId: actor.organizationId,
    userId: actor.userId,
    ...(options?.tokenWorkspaceIds === undefined
      ? {}
      : { tokenWorkspaceIds: options.tokenWorkspaceIds }),
  });

const callTool = async (
  actor: Actor,
  toolName: string,
  args: Record<string, unknown>,
  options?: {
    tokenWorkspaceIds?: readonly SafeId<"workspace">[];
  },
) =>
  await handleMcpToolCall({
    mode: "advanced",
    toolName,
    args,
    context: await buildContext(actor, options),
  });

const expectAllowed = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
  label: string,
) => {
  expect({ label, isError: result.isError === true }).toEqual({
    label,
    isError: false,
  });
};

const expectDenied = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
  label: string,
) => {
  expect({ label, isError: result.isError === true }).toEqual({
    label,
    isError: true,
  });
};

const createOrgAndOwner = async (
  firmName: string,
): Promise<{ organizationId: SafeId<"organization">; owner: Actor }> => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const email = `${userId}@test.local`;
  await testDb
    .insert(user)
    .values({ id: userId, name: `${firmName} Owner`, email });
  await testDb.insert(organization).values({
    id: organizationId,
    name: firmName,
    slug: `firm-${organizationId}`,
    createdAt: FIXED_CREATED_AT,
  });
  await recordNewOrganizationAccessState(testDb, {
    organizationId,
    now: FIXED_CREATED_AT,
  });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: FIXED_CREATED_AT,
  });
  return {
    organizationId,
    owner: { organizationId, userId, role: "owner", email },
  };
};

const addOrgMember = async (
  organizationId: SafeId<"organization">,
  name: string,
  role: MemberRole,
): Promise<Actor> => {
  const userId = mintAuthProviderId<"user">();
  const email = `${userId}@test.local`;
  await testDb.insert(user).values({ id: userId, name, email });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role,
    createdAt: FIXED_CREATED_AT,
  });
  return { organizationId, userId, role, email };
};

const seedTextProperty = async (
  workspaceId: SafeId<"workspace">,
  name: string,
): Promise<SafeId<"property">> => {
  const id = createSafeId<"property">();
  await testDb.insert(properties).values({
    id,
    workspaceId,
    name,
    status: "fresh",
    content: { version: 1, type: "text" },
    tool: { version: 1, type: "manual-input" },
  });
  return id;
};

const seedTimeEntry = async (params: {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  narrative: string;
}): Promise<SafeId<"timeEntry">> => {
  const id = createSafeId<"timeEntry">();
  await testDb.insert(timeEntries).values({
    id,
    organizationId: params.organizationId,
    workspaceId: params.workspaceId,
    userId: params.userId,
    dateWorked: FIXED_WORK_DATE,
    timezoneId: "UTC",
    durationMinutes: 45,
    billedMinutes: 45,
    rateAtEntry: cents(0),
    currency: "EUR",
    narrative: params.narrative,
    billable: false,
  });
  return id;
};

beforeAll(async () => {
  testDb = await getTestDb();

  const firmA = await createOrgAndOwner("Firm Alpha");
  const firmB = await createOrgAndOwner("Firm Beta");

  const memberA = await addOrgMember(
    firmA.organizationId,
    "Alpha Associate",
    "member",
  );
  const collabA = await addOrgMember(
    firmA.organizationId,
    "Alpha External",
    "external",
  );

  // Enrol principals in time-billing in Postgres so resolveMemberAuthorization
  // -> featureAccessSnapshotFromAuthorization reflects real DB state.
  await enrolTimeBilling(testDb, [firmA.owner, firmB.owner, memberA, collabA]);

  // Contacts in both orgs
  const contactA = safeIdFromStructured<"contact">(
    await callTool(firmA.owner, "save_contact", {
      type: "organization",
      display_name: "Alpha Client s.r.o.",
    }),
    "contactId",
  );
  const contactB = safeIdFromStructured<"contact">(
    await callTool(firmB.owner, "save_contact", {
      type: "organization",
      display_name: "Beta Secret Client s.r.o.",
    }),
    "contactId",
  );

  // Matters:
  // - matterA_accessible: active, memberA & collabA assigned
  // - matterA_restricted: active, admins_and_assigned (NOT assigned to memberA/collabA)
  // - matterA_archived: archived, memberA assigned
  // - matterB: active in Firm Beta
  const matterA_accessible = safeIdFromStructured<"workspace">(
    await callTool(firmA.owner, "save_matter", {
      name: "Alpha Shared Deal",
      client_id: contactA,
      visibility: "admins_and_assigned",
    }),
    "matterId",
  );
  const matterA_restricted = safeIdFromStructured<"workspace">(
    await callTool(firmA.owner, "save_matter", {
      name: "Alpha Confidential M&A",
      client_id: contactA,
      visibility: "admins_and_assigned",
    }),
    "matterId",
  );
  const matterA_archived = safeIdFromStructured<"workspace">(
    await callTool(firmA.owner, "save_matter", {
      name: "Alpha Closed Litigation",
      visibility: "admins_and_assigned",
    }),
    "matterId",
  );
  const matterB = safeIdFromStructured<"workspace">(
    await callTool(firmB.owner, "save_matter", {
      name: "Beta Privileged Matter",
      visibility: "admins_and_assigned",
    }),
    "matterId",
  );

  // Assign memberA to matterA_accessible and matterA_archived; collabA to matterA_accessible
  await testDb.insert(workspaceMembers).values([
    { workspaceId: matterA_accessible, userId: memberA.userId },
    { workspaceId: matterA_archived, userId: memberA.userId },
    { workspaceId: matterA_accessible, userId: collabA.userId },
  ]);

  // Seed documents, tasks, text properties across all 4 matters (before archiving matterA_archived)
  const docA1 = safeIdFromStructured<"entity">(
    await callTool(firmA.owner, "save_document", {
      matter_id: matterA_accessible,
      name: "Alpha Shared Memo",
    }),
    "entityId",
  );
  const docA_secret = safeIdFromStructured<"entity">(
    await callTool(firmA.owner, "save_document", {
      matter_id: matterA_restricted,
      name: "Alpha Secret Term Sheet",
    }),
    "entityId",
  );
  const docA_arch = safeIdFromStructured<"entity">(
    await callTool(firmA.owner, "save_document", {
      matter_id: matterA_archived,
      name: "Alpha Archived Judgment",
    }),
    "entityId",
  );
  const docB = safeIdFromStructured<"entity">(
    await callTool(firmB.owner, "save_document", {
      matter_id: matterB,
      name: "Beta Confidential Brief",
    }),
    "entityId",
  );

  const taskA1 = safeIdFromStructured<"entity">(
    await callTool(firmA.owner, "save_task", {
      matter_id: matterA_accessible,
      name: "Review shared NDA",
    }),
    "taskId",
  );
  const taskA_secret = safeIdFromStructured<"entity">(
    await callTool(firmA.owner, "save_task", {
      matter_id: matterA_restricted,
      name: "Finalize secret merger closing",
    }),
    "taskId",
  );
  const taskA_arch = safeIdFromStructured<"entity">(
    await callTool(firmA.owner, "save_task", {
      matter_id: matterA_archived,
      name: "Archive court bundle",
    }),
    "taskId",
  );
  const taskB = safeIdFromStructured<"entity">(
    await callTool(firmB.owner, "save_task", {
      matter_id: matterB,
      name: "Beta privileged strategy call",
    }),
    "taskId",
  );

  const propA1 = await seedTextProperty(matterA_accessible, "Status Note");
  const propA_secret = await seedTextProperty(
    matterA_restricted,
    "Secret Risk",
  );
  const propA_arch = await seedTextProperty(matterA_archived, "Archive Note");
  const propB = await seedTextProperty(matterB, "Beta Risk");

  // Archive matterA_archived via real MCP tool
  const archivedRes = await callTool(firmA.owner, "save_matter", {
    matter_id: matterA_archived,
    status: "archived",
  });
  expect(archivedRes.isError).not.toBe(true);

  // Clauses & Playbooks in both orgs
  const clauseA = safeIdFromStructured<"clause">(
    await callTool(firmA.owner, "save_clause", {
      title: "Alpha Governing Law",
      body: [{ text: "Alpha firm clause text." }],
    }),
    "clauseId",
  );
  const clauseB = safeIdFromStructured<"clause">(
    await callTool(firmB.owner, "save_clause", {
      title: "Beta Proprietary Indemnity",
      body: [{ text: "Beta confidential indemnity clause." }],
    }),
    "clauseId",
  );

  const playbookA = safeIdFromStructured<"playbook">(
    await callTool(firmA.owner, "save_playbook", {
      name: "Alpha Standard Playbook",
    }),
    "playbookId",
  );
  const playbookB = safeIdFromStructured<"playbook">(
    await callTool(firmB.owner, "save_playbook", {
      name: "Beta Secret Playbook",
    }),
    "playbookId",
  );

  // Site notes in Org B
  const siteNoteBRes = await callTool(firmB.owner, "save_site_notes", {
    url: SITE_NOTE_URL,
    changes: [
      {
        type: "add",
        kind: "works",
        step: "beta filter",
        text: "Beta-only research note that Alpha must never see.",
      },
    ],
  });
  expect(siteNoteBRes.isError).not.toBe(true);

  // Time entries
  const timeEntryA1_owner = await seedTimeEntry({
    organizationId: firmA.organizationId,
    workspaceId: matterA_accessible,
    userId: firmA.owner.userId,
    narrative: "Partner confidential strategy review",
  });
  const timeEntryA1_member = await seedTimeEntry({
    organizationId: firmA.organizationId,
    workspaceId: matterA_accessible,
    userId: memberA.userId,
    narrative: "Associate NDA drafting",
  });
  const timeEntryA_secret = await seedTimeEntry({
    organizationId: firmA.organizationId,
    workspaceId: matterA_restricted,
    userId: firmA.owner.userId,
    narrative: "Secret M&A diligence",
  });
  const timeEntryA_arch = await seedTimeEntry({
    organizationId: firmA.organizationId,
    workspaceId: matterA_archived,
    userId: memberA.userId,
    narrative: "Archived litigation closing",
  });
  const timeEntryB = await seedTimeEntry({
    organizationId: firmB.organizationId,
    workspaceId: matterB,
    userId: firmB.owner.userId,
    narrative: "Beta confidential work",
  });

  // Invoices:
  // 1. invoiceA_secret: single-matter invoice on matterA_restricted
  // 2. invoiceA_spanning: client invoice with lines in BOTH matterA_accessible AND matterA_restricted
  // 3. invoiceB: invoice in Firm Beta
  const invoiceA_secret = createSafeId<"invoice">();
  const invoiceA_spanning = createSafeId<"invoice">();
  const invoiceB = createSafeId<"invoice">();

  await testDb.insert(invoices).values([
    {
      id: invoiceA_secret,
      organizationId: firmA.organizationId,
      workspaceId: matterA_restricted,
      invoiceNumber: `INV-A-SEC-${invoiceA_secret}`,
      invoiceDate: FIXED_INVOICE_DATE,
      currency: "EUR",
      status: INVOICE_STATUS.DRAFT,
    },
    {
      id: invoiceA_spanning,
      organizationId: firmA.organizationId,
      clientId: contactA,
      workspaceId: null,
      invoiceNumber: `INV-A-SPAN-${invoiceA_spanning}`,
      invoiceDate: FIXED_INVOICE_DATE,
      currency: "EUR",
      status: INVOICE_STATUS.DRAFT,
    },
    {
      id: invoiceB,
      organizationId: firmB.organizationId,
      workspaceId: matterB,
      invoiceNumber: `INV-B-${invoiceB}`,
      invoiceDate: FIXED_INVOICE_DATE,
      currency: "EUR",
      status: INVOICE_STATUS.DRAFT,
    },
  ]);

  await testDb.insert(invoiceLines).values([
    {
      id: createSafeId<"invoiceLine">(),
      organizationId: firmA.organizationId,
      workspaceId: matterA_accessible,
      invoiceId: invoiceA_spanning,
      position: 0,
      description: "Accessible matter line",
      quantity: "1.0000",
      unit: "h",
      unitPrice: cents(100),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat",
      netAmount: cents(100),
      vatAmount: cents(21),
      grossAmount: cents(121),
      source: "manual",
    },
    {
      id: createSafeId<"invoiceLine">(),
      organizationId: firmA.organizationId,
      workspaceId: matterA_restricted,
      invoiceId: invoiceA_spanning,
      position: 1,
      description: "Restricted matter confidential line",
      quantity: "2.0000",
      unit: "h",
      unitPrice: cents(100),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat",
      netAmount: cents(200),
      vatAmount: cents(42),
      grossAmount: cents(242),
      source: "manual",
    },
  ]);

  fx = {
    orgA: firmA.organizationId,
    orgB: firmB.organizationId,
    ownerA: firmA.owner,
    memberA,
    collabA,
    ownerB: firmB.owner,
    matterA_accessible,
    matterA_restricted,
    matterA_archived,
    matterB,
    docA1,
    docA_secret,
    docA_arch,
    docB,
    taskA1,
    taskA_secret,
    taskA_arch,
    taskB,
    propA1,
    propA_secret,
    propA_arch,
    propB,
    contactA,
    contactB,
    clauseA,
    clauseB,
    playbookA,
    playbookB,
    timeEntryA1_owner,
    timeEntryA1_member,
    timeEntryA_secret,
    timeEntryA_arch,
    timeEntryB,
    invoiceA_secret,
    invoiceA_spanning,
    invoiceB,
  };
});

afterAll(async () => {
  await releaseTestDb();
});

describe("MCP adversarial runtime isolation", () => {
  describe("1. Cross-tenant isolation (Org A owner -> Org B resources)", () => {
    test("org A owner cannot read any org B resource via list or detail tools", async () => {
      // List tools must never leak org B IDs or names
      const matters = await callTool(fx.ownerA, "list_matters", {});
      expect(matters.isError).not.toBe(true);
      expect(textOf(matters)).not.toContain(fx.matterB);
      expect(textOf(matters)).not.toContain("Beta Privileged Matter");

      const contacts = await callTool(fx.ownerA, "list_contacts", {});
      expect(contacts.isError).not.toBe(true);
      expect(textOf(contacts)).not.toContain(fx.contactB);

      const tasks = await callTool(fx.ownerA, "list_tasks", {});
      expect(tasks.isError).not.toBe(true);
      expect(textOf(tasks)).not.toContain(fx.taskB);

      const clauses = await callTool(fx.ownerA, "list_clauses", {});
      expect(clauses.isError).not.toBe(true);
      expect(textOf(clauses)).not.toContain(fx.clauseB);

      const playbooks = await callTool(fx.ownerA, "list_playbooks", {});
      expect(playbooks.isError).not.toBe(true);
      expect(textOf(playbooks)).not.toContain(fx.playbookB);

      const siteNotes = await callTool(fx.ownerA, "read_site_notes", {
        url: SITE_NOTE_URL,
      });
      expect(siteNotes.isError).not.toBe(true);
      expect(textOf(siteNotes)).not.toContain("Beta-only research note");

      // Positive controls: each owner can read their own tenant resources
      expectAllowed(
        await callTool(fx.ownerA, "read_document", { entity_id: fx.docA1 }),
        "control: ownerA read_document(docA1)",
      );
      expectAllowed(
        await callTool(fx.ownerB, "read_document", { entity_id: fx.docB }),
        "control: ownerB read_document(docB)",
      );
      expectAllowed(
        await callTool(fx.ownerB, "read_contact", { contact_id: fx.contactB }),
        "control: ownerB read_contact(contactB)",
      );
      expectAllowed(
        await callTool(fx.ownerB, "list_invoices", { invoice_id: fx.invoiceB }),
        "control: ownerB list_invoices(invoiceB)",
      );

      // Direct ID probes into Org B must all be denied
      const deniedReads: readonly [string, Record<string, unknown>][] = [
        ["list_documents(matterB)", { matter_id: fx.matterB }],
        ["read_document(docB)", { entity_id: fx.docB }],
        ["list_properties(matterB)", { matter_id: fx.matterB }],
        ["list_tasks(matterB)", { matter_id: fx.matterB }],
        ["list_tasks(taskB)", { task_id: fx.taskB }],
        ["read_contact(contactB)", { contact_id: fx.contactB }],
        ["list_clauses(clauseB)", { clause_id: fx.clauseB }],
        ["list_playbooks(playbookB)", { playbook_id: fx.playbookB }],
        ["list_time_entries(matterB)", { matter_id: fx.matterB }],
        ["list_time_entries(timeEntryB)", { time_entry_id: fx.timeEntryB }],
        [
          "resolve_rate(matterB, ownerB)",
          {
            matter_id: fx.matterB,
            user_id: fx.ownerB.userId,
            date: FIXED_WORK_DATE,
          },
        ],
        [
          "resolve_rate(matterA, ownerB)",
          {
            matter_id: fx.matterA_accessible,
            user_id: fx.ownerB.userId,
            date: FIXED_WORK_DATE,
          },
        ],
        ["list_invoices(matterB)", { matter_id: fx.matterB }],
        ["list_invoices(invoiceB)", { invoice_id: fx.invoiceB }],
      ];

      for (const [label, args] of deniedReads) {
        const toolName = label.slice(0, label.indexOf("("));
        const res = await callTool(fx.ownerA, toolName, args);
        expectDenied(res, label);
      }
    });

    test("org A owner cannot mutate or cross-link any org B resource", async () => {
      const deniedWrites: readonly [string, string, Record<string, unknown>][] =
        [
          [
            "save_matter(update matterB)",
            "save_matter",
            { matter_id: fx.matterB, name: "Hijacked" },
          ],
          [
            "save_matter(create with contactB)",
            "save_matter",
            { name: "Cross-org client", client_id: fx.contactB },
          ],
          [
            "save_matter(update matterA with contactB)",
            "save_matter",
            { matter_id: fx.matterA_accessible, client_id: fx.contactB },
          ],
          [
            "save_document(create in matterB)",
            "save_document",
            { matter_id: fx.matterB, name: "Injected" },
          ],
          [
            "save_document(update docB)",
            "save_document",
            { entity_id: fx.docB, name: "Hijacked Doc" },
          ],
          [
            "delete_document(docB)",
            "delete_document",
            { entity_id: fx.docB, confirm: true },
          ],
          [
            "set_field_value(docB, propB)",
            "set_field_value",
            {
              entity_id: fx.docB,
              property_id: fx.propB,
              content: { type: "text", value: "injected" },
            },
          ],
          [
            "save_task(create in matterB)",
            "save_task",
            { matter_id: fx.matterB, name: "Injected Task" },
          ],
          [
            "save_task(update taskB)",
            "save_task",
            { task_id: fx.taskB, name: "Hijacked Task" },
          ],
          [
            "save_task(link docB onto taskA1)",
            "save_task",
            { task_id: fx.taskA1, link_entity_id: fx.docB },
          ],
          [
            "save_task(assign ownerB to taskA1)",
            "save_task",
            { task_id: fx.taskA1, assignee: fx.ownerB.userId },
          ],
          [
            "delete_task(taskB)",
            "delete_task",
            { task_id: fx.taskB, confirm: true },
          ],
          [
            "save_contact(update contactB)",
            "save_contact",
            { contact_id: fx.contactB, display_name: "Hijacked Contact" },
          ],
          [
            "delete_contact(contactB)",
            "delete_contact",
            { contact_id: fx.contactB, confirm: true },
          ],
          [
            "link_matter_contact(matterA + contactB)",
            "link_matter_contact",
            {
              matter_id: fx.matterA_accessible,
              contact_id: fx.contactB,
              role: "opposing_party",
            },
          ],
          [
            "save_clause(update clauseB)",
            "save_clause",
            { clause_id: fx.clauseB, title: "Hijacked Clause" },
          ],
          [
            "delete_clause(clauseB)",
            "delete_clause",
            { clause_id: fx.clauseB, confirm: true },
          ],
          [
            "save_playbook(update playbookB)",
            "save_playbook",
            { playbook_id: fx.playbookB, name: "Hijacked Playbook" },
          ],
          [
            "save_time_entry(create in matterB)",
            "save_time_entry",
            {
              matter_id: fx.matterB,
              date_worked: FIXED_WORK_DATE,
              timezone_id: "UTC",
              duration_minutes: 15,
              narrative: "Injected",
              billable: false,
            },
          ],
          [
            "save_time_entry(update timeEntryB)",
            "save_time_entry",
            { time_entry_id: fx.timeEntryB, narrative: "Hijacked" },
          ],
          [
            "delete_time_entry(timeEntryB)",
            "delete_time_entry",
            { time_entry_id: fx.timeEntryB, confirm: true },
          ],
          [
            "add_matter_member(matterA + ownerB)",
            "add_matter_member",
            { matter_id: fx.matterA_accessible, user_id: fx.ownerB.userId },
          ],
          [
            "add_matter_member(matterB + ownerA)",
            "add_matter_member",
            { matter_id: fx.matterB, user_id: fx.ownerA.userId },
          ],
          [
            "remove_matter_member(matterB + ownerB)",
            "remove_matter_member",
            {
              matter_id: fx.matterB,
              user_id: fx.ownerB.userId,
              confirm: true,
            },
          ],
        ];

      for (const [label, toolName, args] of deniedWrites) {
        const res = await callTool(fx.ownerA, toolName, args);
        expectDenied(res, label);
      }

      // Verify Org B records in DB remain completely intact
      const [matterRow] = await testDb
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, fx.matterB));
      expect(matterRow?.name).toBe("Beta Privileged Matter");

      const [docRow] = await testDb
        .select({ name: entities.name })
        .from(entities)
        .where(eq(entities.id, fx.docB));
      expect(docRow?.name).toBe("Beta Confidential Brief");

      const [taskRow] = await testDb
        .select({ name: entities.name })
        .from(entities)
        .where(eq(entities.id, fx.taskB));
      expect(taskRow?.name).toBe("Beta privileged strategy call");

      const [entryRow] = await testDb
        .select({ narrative: timeEntries.narrative })
        .from(timeEntries)
        .where(eq(timeEntries.id, fx.timeEntryB));
      expect(entryRow?.narrative).toBe("Beta confidential work");
    });
  });

  describe("2. Intra-org ethical wall & cross-member privacy", () => {
    test("memberA cannot read or mutate unassigned restricted matterA_restricted", async () => {
      const matters = await callTool(fx.memberA, "list_matters", {});
      expect(matters.isError).not.toBe(true);
      expect(textOf(matters)).toContain(fx.matterA_accessible);
      expect(textOf(matters)).not.toContain(fx.matterA_restricted);

      const allTasks = await callTool(fx.memberA, "list_tasks", {});
      expect(allTasks.isError).not.toBe(true);
      expect(textOf(allTasks)).toContain(fx.taskA1);
      expect(textOf(allTasks)).not.toContain(fx.taskA_secret);

      const blockedCalls: readonly [string, string, Record<string, unknown>][] =
        [
          [
            "list_documents(restricted)",
            "list_documents",
            { matter_id: fx.matterA_restricted },
          ],
          [
            "read_document(docA_secret)",
            "read_document",
            { entity_id: fx.docA_secret },
          ],
          [
            "save_document(create in restricted)",
            "save_document",
            { matter_id: fx.matterA_restricted, name: "Bypass" },
          ],
          [
            "save_document(update docA_secret)",
            "save_document",
            { entity_id: fx.docA_secret, name: "Bypass" },
          ],
          [
            "delete_document(docA_secret)",
            "delete_document",
            { entity_id: fx.docA_secret, confirm: true },
          ],
          [
            "list_properties(restricted)",
            "list_properties",
            { matter_id: fx.matterA_restricted },
          ],
          [
            "set_field_value(docA_secret)",
            "set_field_value",
            {
              entity_id: fx.docA_secret,
              property_id: fx.propA_secret,
              content: { type: "text", value: "bypass" },
            },
          ],
          [
            "list_tasks(restricted)",
            "list_tasks",
            { matter_id: fx.matterA_restricted },
          ],
          [
            "list_tasks(taskA_secret)",
            "list_tasks",
            { task_id: fx.taskA_secret },
          ],
          [
            "save_task(create in restricted)",
            "save_task",
            { matter_id: fx.matterA_restricted, name: "Bypass Task" },
          ],
          [
            "save_task(update taskA_secret)",
            "save_task",
            { task_id: fx.taskA_secret, name: "Bypass" },
          ],
          [
            "save_task(link docA_secret onto taskA1)",
            "save_task",
            { task_id: fx.taskA1, link_entity_id: fx.docA_secret },
          ],
          [
            "delete_task(taskA_secret)",
            "delete_task",
            { task_id: fx.taskA_secret, confirm: true },
          ],
          [
            "list_time_entries(restricted)",
            "list_time_entries",
            { matter_id: fx.matterA_restricted },
          ],
          [
            "list_time_entries(timeEntryA_secret)",
            "list_time_entries",
            { time_entry_id: fx.timeEntryA_secret },
          ],
          [
            "save_time_entry(create in restricted)",
            "save_time_entry",
            {
              matter_id: fx.matterA_restricted,
              date_worked: FIXED_WORK_DATE,
              timezone_id: "UTC",
              duration_minutes: 15,
              narrative: "Bypass",
              billable: false,
            },
          ],
          [
            "save_time_entry(update timeEntryA_secret)",
            "save_time_entry",
            { time_entry_id: fx.timeEntryA_secret, narrative: "Bypass" },
          ],
          [
            "delete_time_entry(timeEntryA_secret)",
            "delete_time_entry",
            { time_entry_id: fx.timeEntryA_secret, confirm: true },
          ],
          [
            "list_invoices(restricted)",
            "list_invoices",
            { matter_id: fx.matterA_restricted },
          ],
          [
            "list_invoices(invoiceA_secret)",
            "list_invoices",
            { invoice_id: fx.invoiceA_secret },
          ],
          // Multi-matter client invoice spanning accessible + restricted matters
          // must NOT be readable by memberA because it touches matterA_restricted.
          [
            "list_invoices(invoiceA_spanning)",
            "list_invoices",
            { invoice_id: fx.invoiceA_spanning },
          ],
        ];

      // Positive controls: ownerA can access restricted resources and memberA
      // can access assigned matterA_accessible resources.
      expectAllowed(
        await callTool(fx.ownerA, "read_document", {
          entity_id: fx.docA_secret,
        }),
        "control: ownerA read_document(docA_secret)",
      );
      expectAllowed(
        await callTool(fx.ownerA, "list_invoices", {
          invoice_id: fx.invoiceA_spanning,
        }),
        "control: ownerA list_invoices(invoiceA_spanning)",
      );
      expectAllowed(
        await callTool(fx.memberA, "read_document", { entity_id: fx.docA1 }),
        "control: memberA read_document(docA1)",
      );

      for (const [label, toolName, args] of blockedCalls) {
        const res = await callTool(fx.memberA, toolName, args);
        expectDenied(res, label);
      }

      // Verify restricted matter entities untouched
      const [secretDoc] = await testDb
        .select({ name: entities.name })
        .from(entities)
        .where(eq(entities.id, fx.docA_secret));
      expect(secretDoc?.name).toBe("Alpha Secret Term Sheet");
    });

    test("memberA cannot read, filter, update, or delete ownerA's time entry in shared matter", async () => {
      const ownList = await callTool(fx.memberA, "list_time_entries", {
        matter_id: fx.matterA_accessible,
      });
      expect(ownList.isError).not.toBe(true);
      expect(textOf(ownList)).toContain(fx.timeEntryA1_member);
      expect(textOf(ownList)).not.toContain(fx.timeEntryA1_owner);

      const denied: readonly [string, string, Record<string, unknown>][] = [
        [
          "list_time_entries(filter by ownerA)",
          "list_time_entries",
          { matter_id: fx.matterA_accessible, user_id: fx.ownerA.userId },
        ],
        [
          "list_time_entries(detail ownerA entry)",
          "list_time_entries",
          { time_entry_id: fx.timeEntryA1_owner },
        ],
        [
          "save_time_entry(update ownerA entry)",
          "save_time_entry",
          { time_entry_id: fx.timeEntryA1_owner, narrative: "Tampered" },
        ],
        [
          "delete_time_entry(delete ownerA entry)",
          "delete_time_entry",
          { time_entry_id: fx.timeEntryA1_owner, confirm: true },
        ],
      ];

      for (const [label, toolName, args] of denied) {
        expectDenied(await callTool(fx.memberA, toolName, args), label);
      }

      const [entryRow] = await testDb
        .select({ narrative: timeEntries.narrative })
        .from(timeEntries)
        .where(eq(timeEntries.id, fx.timeEntryA1_owner));
      expect(entryRow?.narrative).toBe("Partner confidential strategy review");
    });
  });

  describe("3. Token-scoped workspace narrowing (tokenWorkspaceIds)", () => {
    test("org A owner pinned to matterA_accessible cannot access matterA_restricted or spanning invoice", async () => {
      const pinned = { tokenWorkspaceIds: [fx.matterA_accessible] };

      // Positive control: unpinned ownerA can see restricted matter and secret doc
      const unpinnedMatters = await callTool(fx.ownerA, "list_matters", {});
      expectAllowed(unpinnedMatters, "control: unpinned ownerA list_matters");
      expect(textOf(unpinnedMatters)).toContain(fx.matterA_restricted);
      expectAllowed(
        await callTool(fx.ownerA, "read_document", {
          entity_id: fx.docA_secret,
        }),
        "control: unpinned ownerA read_document(docA_secret)",
      );

      // Direct RLS verification: createMcpOperationDatabases switches Postgres
      // RLS to explicit mode for tokenWorkspaceIds, so even an unfiltered table
      // scan through pinnedContext.scopedDb only sees matterA_accessible rows.
      const pinnedContext = await buildContext(fx.ownerA, pinned);
      const rlsRows = await pinnedContext.scopedDb(
        async (tx) =>
          await tx
            .select({ id: entities.id, workspaceId: entities.workspaceId })
            .from(entities),
      );
      const visibleEntityIds = new Set(rlsRows.map((row) => row.id));
      expect(visibleEntityIds.has(fx.docA1)).toBe(true);
      expect(visibleEntityIds.has(fx.docA_secret)).toBe(false);
      expect(visibleEntityIds.has(fx.docB)).toBe(false);

      // Positive control under pinned token: reads inside matterA_accessible succeed
      expectAllowed(
        await callTool(
          fx.ownerA,
          "read_document",
          { entity_id: fx.docA1 },
          pinned,
        ),
        "control: pinned ownerA read_document(docA1)",
      );

      const matters = await callTool(fx.ownerA, "list_matters", {}, pinned);
      expect(matters.isError).not.toBe(true);
      expect(textOf(matters)).toContain(fx.matterA_accessible);
      expect(textOf(matters)).not.toContain(fx.matterA_restricted);

      const accessibleInvoices = await callTool(
        fx.ownerA,
        "list_invoices",
        { matter_id: fx.matterA_accessible },
        pinned,
      );
      expect(accessibleInvoices.isError).not.toBe(true);
      // Even though ownerA is org owner, the token is pinned to matterA_accessible,
      // so the multi-matter invoice touching matterA_restricted must be excluded.
      expect(textOf(accessibleInvoices)).not.toContain(fx.invoiceA_spanning);

      const blocked: readonly [string, string, Record<string, unknown>][] = [
        [
          "read_document(docA_secret)",
          "read_document",
          { entity_id: fx.docA_secret },
        ],
        [
          "save_document(docA_secret)",
          "save_document",
          { entity_id: fx.docA_secret, name: "Token Escape" },
        ],
        [
          "list_tasks(taskA_secret)",
          "list_tasks",
          { task_id: fx.taskA_secret },
        ],
        [
          "list_time_entries(timeEntryA_secret)",
          "list_time_entries",
          { time_entry_id: fx.timeEntryA_secret },
        ],
        [
          "list_invoices(invoiceA_secret)",
          "list_invoices",
          { invoice_id: fx.invoiceA_secret },
        ],
        [
          "list_invoices(invoiceA_spanning)",
          "list_invoices",
          { invoice_id: fx.invoiceA_spanning },
        ],
        [
          "save_matter(update restricted)",
          "save_matter",
          { matter_id: fx.matterA_restricted, name: "Token Escape" },
        ],
      ];

      for (const [label, toolName, args] of blocked) {
        expectDenied(await callTool(fx.ownerA, toolName, args, pinned), label);
      }
    });
  });

  describe("4. Archived matter write freeze", () => {
    test("reads succeed on matterA_archived while every write is rejected", async () => {
      const readDoc = await callTool(fx.memberA, "read_document", {
        entity_id: fx.docA_arch,
      });
      expect(readDoc.isError).not.toBe(true);

      const listTasks = await callTool(fx.memberA, "list_tasks", {
        matter_id: fx.matterA_archived,
      });
      expect(listTasks.isError).not.toBe(true);
      expect(textOf(listTasks)).toContain(fx.taskA_arch);

      const blockedWrites: readonly [
        string,
        Actor,
        string,
        Record<string, unknown>,
      ][] = [
        [
          "save_document(create in archived)",
          fx.ownerA,
          "save_document",
          { matter_id: fx.matterA_archived, name: "New Doc" },
        ],
        [
          "save_document(update docA_arch)",
          fx.ownerA,
          "save_document",
          { entity_id: fx.docA_arch, name: "Edited Archived Doc" },
        ],
        [
          "delete_document(docA_arch)",
          fx.ownerA,
          "delete_document",
          { entity_id: fx.docA_arch, confirm: true },
        ],
        [
          "set_field_value(docA_arch)",
          fx.ownerA,
          "set_field_value",
          {
            entity_id: fx.docA_arch,
            property_id: fx.propA_arch,
            content: { type: "text", value: "mutated" },
          },
        ],
        [
          "save_task(create in archived)",
          fx.ownerA,
          "save_task",
          { matter_id: fx.matterA_archived, name: "New Task" },
        ],
        [
          "save_task(update taskA_arch)",
          fx.ownerA,
          "save_task",
          { task_id: fx.taskA_arch, name: "Edited Task" },
        ],
        [
          "delete_task(taskA_arch)",
          fx.ownerA,
          "delete_task",
          { task_id: fx.taskA_arch, confirm: true },
        ],
        [
          "save_time_entry(create in archived)",
          fx.memberA,
          "save_time_entry",
          {
            matter_id: fx.matterA_archived,
            date_worked: FIXED_WORK_DATE,
            timezone_id: "UTC",
            duration_minutes: 10,
            narrative: "Post-archive work",
            billable: false,
          },
        ],
        [
          "save_time_entry(update timeEntryA_arch)",
          fx.memberA,
          "save_time_entry",
          { time_entry_id: fx.timeEntryA_arch, narrative: "Edited" },
        ],
        [
          "delete_time_entry(timeEntryA_arch)",
          fx.memberA,
          "delete_time_entry",
          { time_entry_id: fx.timeEntryA_arch, confirm: true },
        ],
        [
          "save_matter(rename archived)",
          fx.ownerA,
          "save_matter",
          { matter_id: fx.matterA_archived, name: "Renamed Archived" },
        ],
        [
          "add_matter_member(archived)",
          fx.ownerA,
          "add_matter_member",
          { matter_id: fx.matterA_archived, user_id: fx.collabA.userId },
        ],
      ];

      for (const [label, actor, toolName, args] of blockedWrites) {
        expectDenied(await callTool(actor, toolName, args), label);
      }

      const [archDoc] = await testDb
        .select({ name: entities.name })
        .from(entities)
        .where(eq(entities.id, fx.docA_arch));
      expect(archDoc?.name).toBe("Alpha Archived Judgment");
    });
  });

  describe("5. External collaborator role boundary & entity/matter confusion guards", () => {
    test("external assigned to matterA_accessible is denied every write tool", async () => {
      const readDoc = await callTool(fx.collabA, "read_document", {
        entity_id: fx.docA1,
      });
      expect(readDoc.isError).not.toBe(true);

      const forbiddenWrites: readonly [
        string,
        string,
        Record<string, unknown>,
      ][] = [
        ["save_matter(create)", "save_matter", { name: "Unauthorized Matter" }],
        [
          "save_matter(update)",
          "save_matter",
          { matter_id: fx.matterA_accessible, name: "Renamed" },
        ],
        [
          "save_document(create)",
          "save_document",
          { matter_id: fx.matterA_accessible, name: "Unauthorized Doc" },
        ],
        [
          "save_document(update)",
          "save_document",
          { entity_id: fx.docA1, name: "Renamed Doc" },
        ],
        [
          "delete_document",
          "delete_document",
          { entity_id: fx.docA1, confirm: true },
        ],
        [
          "set_field_value",
          "set_field_value",
          {
            entity_id: fx.docA1,
            property_id: fx.propA1,
            content: { type: "text", value: "x" },
          },
        ],
        [
          "save_task(create)",
          "save_task",
          { matter_id: fx.matterA_accessible, name: "Unauthorized Task" },
        ],
        [
          "save_task(update)",
          "save_task",
          { task_id: fx.taskA1, name: "Renamed Task" },
        ],
        ["delete_task", "delete_task", { task_id: fx.taskA1, confirm: true }],
        [
          "save_contact(create)",
          "save_contact",
          { type: "organization", display_name: "Unauthorized Contact" },
        ],
        [
          "save_clause(create)",
          "save_clause",
          { title: "Unauthorized Clause", body: [{ text: "x" }] },
        ],
        [
          "save_playbook(create)",
          "save_playbook",
          { name: "Unauthorized Playbook" },
        ],
        [
          "add_matter_member",
          "add_matter_member",
          { matter_id: fx.matterA_accessible, user_id: fx.memberA.userId },
        ],
        [
          "update_organization_settings",
          "update_organization_settings",
          { time_narrative_required: true },
        ],
      ];

      for (const [label, toolName, args] of forbiddenWrites) {
        expectDenied(await callTool(fx.collabA, toolName, args), label);
      }
    });

    test("entity-kind confusion and matter-pairing mismatches are rejected without cross-tenant oracle leakage", async () => {
      // Own accessible entity of wrong kind -> explicit wrong-kind rejection
      const taskAsDoc = await callTool(fx.ownerA, "read_document", {
        entity_id: fx.taskA1,
      });
      expectDenied(taskAsDoc, "read_document(taskA1)");
      expect(textOf(taskAsDoc)).toContain("Not a document or folder entity");

      const docAsTask = await callTool(fx.ownerA, "list_tasks", {
        task_id: fx.docA1,
      });
      expectDenied(docAsTask, "list_tasks(docA1)");
      expect(textOf(docAsTask)).toContain("Not a task entity");

      // Cross-tenant wrong-kind entity MUST return generic not-found (never leak entity existence/type)
      const orgBTaskAsDoc = await callTool(fx.ownerA, "read_document", {
        entity_id: fx.taskB,
      });
      expectDenied(orgBTaskAsDoc, "read_document(taskB)");
      expect(textOf(orgBTaskAsDoc)).not.toContain("Not a document");

      const orgBDocAsTask = await callTool(fx.ownerA, "list_tasks", {
        task_id: fx.docB,
      });
      expectDenied(orgBDocAsTask, "list_tasks(docB)");
      expect(textOf(orgBDocAsTask)).not.toContain("Not a task");

      // Matter-pairing mismatches across two accessible matters
      const mismatchedTask = await callTool(fx.ownerA, "list_tasks", {
        matter_id: fx.matterA_archived,
        task_id: fx.taskA1,
      });
      expectDenied(mismatchedTask, "list_tasks(matterA_archived, taskA1)");

      const mismatchedTimeEntry = await callTool(
        fx.ownerA,
        "list_time_entries",
        {
          matter_id: fx.matterA_archived,
          time_entry_id: fx.timeEntryA1_owner,
        },
      );
      expectDenied(
        mismatchedTimeEntry,
        "list_time_entries(matterA_archived, timeEntryA1_owner)",
      );
    });
  });

  describe("6. Live revocation after matter-assignment removal", () => {
    test("removing memberA from matterA_accessible immediately revokes all reads and writes", async () => {
      // Confirm access before removal
      const before = await callTool(fx.memberA, "read_document", {
        entity_id: fx.docA1,
      });
      expect(before.isError).not.toBe(true);

      // Remove memberA's assignment from matterA_accessible
      await testDb
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, fx.matterA_accessible),
            eq(workspaceMembers.userId, fx.memberA.userId),
          ),
        );

      const postRevocation: readonly [
        string,
        string,
        Record<string, unknown>,
      ][] = [
        [
          "list_documents(after removal)",
          "list_documents",
          { matter_id: fx.matterA_accessible },
        ],
        [
          "read_document(after removal)",
          "read_document",
          { entity_id: fx.docA1 },
        ],
        [
          "save_document(after removal)",
          "save_document",
          { entity_id: fx.docA1, name: "Post-revocation edit" },
        ],
        ["list_tasks(after removal)", "list_tasks", { task_id: fx.taskA1 }],
        [
          "list_time_entries(after removal)",
          "list_time_entries",
          { time_entry_id: fx.timeEntryA1_member },
        ],
      ];

      for (const [label, toolName, args] of postRevocation) {
        expectDenied(await callTool(fx.memberA, toolName, args), label);
      }

      // Positive control: ownerA still retains access to matterA_accessible
      expectAllowed(
        await callTool(fx.ownerA, "read_document", { entity_id: fx.docA1 }),
        "control: ownerA read_document(docA1) after memberA removal",
      );
    });
  });
});
