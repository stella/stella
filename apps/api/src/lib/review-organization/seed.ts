import { Result, TaggedError } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  clauses,
  contacts,
  entities,
  featureEnrolments,
  playbookDefinitions,
  rateTables,
  templates,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import { createClauseHandler } from "@/api/handlers/clauses/create";
import { createContactHandler } from "@/api/handlers/contacts/create";
import { enrolFeatureHandler } from "@/api/handlers/organization-settings/feature-enrolments/enrol";
import { createPlaybookDefinitionHandler } from "@/api/handlers/playbooks/create-shared";
import { createRateTableHandler } from "@/api/handlers/rates/create";
import { createRateEntryHandler } from "@/api/handlers/rates/entries/create";
import { createWorkspaceHandler } from "@/api/handlers/workspaces/create";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createTimeEntryHandler } from "@/api/lib/billing/time-entry-insert";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { ensureDefaultDocumentTypes } from "@/api/lib/document-types/defaults";
import { markdownToStellaDocx } from "@/api/lib/docx-authoring/from-markdown";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload-handler";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { createTextPdf } from "@/api/lib/files/text-pdf";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { inOrder } from "@/api/lib/review-organization/in-order";
import {
  SAMPLE_CLAUSES,
  SAMPLE_CONTACTS,
  SAMPLE_MATTERS,
  SAMPLE_PLAYBOOK,
  SAMPLE_RATE_TABLE,
  SAMPLE_TEMPLATE,
} from "@/api/lib/review-organization/sample-data";
import type {
  SampleContact,
  SampleDocument,
  SampleMatter,
} from "@/api/lib/review-organization/sample-data";
import { brandDerivedSampleId } from "@/api/lib/safe-id-boundaries";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";
import { createStoredTemplate } from "@/api/lib/templates/create-template";
import type {
  PlaybookPositions,
  Position,
} from "@/api/lib/workflow/playbook-positions";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

/** One sample item the seeder could not write. */
export class ReviewSeedError extends TaggedError("ReviewSeedError")<{
  message: string;
  item: string;
  cause: unknown;
}> {}

/**
 * The review account acting in its own organization. Every write goes through
 * the same handlers a member request or an MCP tool call uses, on a handle
 * scoped to this organization and this member, so row-level security confines
 * the seed exactly as it confines the account.
 */
export type ReviewSeedActor = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  userEmail: string;
  /** The account's authority, built where its membership was proved. */
  memberAuthority: AuthorizedMemberRole;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  /** The recorder for one matter, or for organization-level rows (null). */
  recorderFor: (workspaceId: SafeId<"workspace"> | null) => AuditRecorder;
};

export type ReviewSeedDependencies = {
  /** Side effects after a document is stored (extraction, derivatives). */
  documents?: CreateEntityFromBufferDependencies | undefined;
};

export type ReviewSeedKind =
  | "contacts"
  | "matters"
  | "documents"
  | "tasks"
  | "timeEntries"
  | "clauses"
  | "templates"
  | "playbooks"
  | "rateTables"
  | "enrolments";

/** Per kind: items this run wrote, and items an earlier run had written. */
export type ReviewSeedCounts = Record<
  ReviewSeedKind,
  { created: number; existing: number }
>;

const emptyCounts = (): ReviewSeedCounts => ({
  contacts: { created: 0, existing: 0 },
  matters: { created: 0, existing: 0 },
  documents: { created: 0, existing: 0 },
  tasks: { created: 0, existing: 0 },
  timeEntries: { created: 0, existing: 0 },
  clauses: { created: 0, existing: 0 },
  templates: { created: 0, existing: 0 },
  playbooks: { created: 0, existing: 0 },
  rateTables: { created: 0, existing: 0 },
  enrolments: { created: 0, existing: 0 },
});

/**
 * A stable id for one sample item in one organization, so a rerun finds what
 * an earlier run wrote instead of writing it twice.
 */
export const reviewSampleId = <T extends SafeIdType>(
  organizationId: SafeId<"organization">,
  key: string,
): SafeId<T> =>
  brandDerivedSampleId<T>(`review-organization:${organizationId}:${key}`);

const seedError = (item: string, cause: unknown) =>
  new ReviewSeedError({
    message: `Could not seed the sample ${item}`,
    item,
    cause,
  });

const contactBody = (
  organizationId: SafeId<"organization">,
  contact: SampleContact,
) => {
  const id = reviewSampleId<"contact">(
    organizationId,
    `contact:${contact.key}`,
  );
  const email = [
    { type: "work" as const, address: contact.email, isPrimary: true },
  ];
  if (contact.type === "organization") {
    return {
      id,
      type: contact.type,
      organizationName: contact.organizationName,
      displayName: contact.organizationName,
      registrationNumber: contact.registrationNumber,
      emails: email,
      notes: contact.notes,
    };
  }
  return {
    id,
    type: contact.type,
    firstName: contact.firstName,
    lastName: contact.lastName,
    displayName: `${contact.firstName} ${contact.lastName}`,
    emails: email,
    notes: contact.notes,
  };
};

const seedContacts = async (
  actor: ReviewSeedActor,
  counts: ReviewSeedCounts,
): Promise<Result<void, ReviewSeedError>> => {
  const bodies = SAMPLE_CONTACTS.map((contact) =>
    contactBody(actor.organizationId, contact),
  );
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, actor.organizationId),
          inArray(
            contacts.id,
            bodies.map((body) => body.id),
          ),
        ),
      )
      .limit(bodies.length),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("contacts", existing.error));
  }
  const existingIds = new Set(existing.value.map(({ id }) => id));
  return await inOrder(bodies, async (body) => {
    if (existingIds.has(body.id)) {
      counts.contacts.existing += 1;
      return Result.ok(undefined);
    }
    const created = await Result.gen(() =>
      createContactHandler({
        safeDb: actor.safeDb,
        organizationId: actor.organizationId,
        userId: actor.userId,
        recordAuditEvent: actor.recorderFor(null),
        body,
      }),
    );
    if (Result.isError(created)) {
      return Result.err(
        seedError(`contact ${body.displayName}`, created.error),
      );
    }
    counts.contacts.created += 1;
    return Result.ok(undefined);
  });
};

const documentBytes = async (
  document: SampleDocument,
): Promise<Result<Uint8Array, ReviewSeedError>> => {
  if (document.format === "pdf") {
    return Result.ok(
      new Uint8Array(createTextPdf(document.title, document.body)),
    );
  }
  const docx = await markdownToStellaDocx(document.body);
  if (Result.isError(docx)) {
    return Result.err(seedError(`document ${document.fileName}`, docx.error));
  }
  return Result.ok(new Uint8Array(docx.value));
};

/** One seeded matter, as each of its per-matter steps receives it. */
type MatterStep = {
  actor: ReviewSeedActor;
  workspaceId: SafeId<"workspace">;
  matter: SampleMatter;
  dependencies: ReviewSeedDependencies;
  counts: ReviewSeedCounts;
};

const seedDocuments = async ({
  actor,
  workspaceId,
  matter,
  dependencies,
  counts,
}: MatterStep): Promise<Result<void, ReviewSeedError>> => {
  const fileNames = matter.documents.map(({ fileName }) => fileName);
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ name: entities.name })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          eq(entities.kind, "document"),
          inArray(entities.name, fileNames),
        ),
      )
      .limit(fileNames.length),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("documents", existing.error));
  }
  const existingNames = new Set(existing.value.map(({ name }) => name));
  return await inOrder(matter.documents, async (document) => {
    if (existingNames.has(document.fileName)) {
      counts.documents.existing += 1;
      return Result.ok(undefined);
    }
    const bytes = await documentBytes(document);
    if (Result.isError(bytes)) {
      return bytes;
    }
    const created = await createEntityFromBuffer({
      scopedDb: actor.scopedDb,
      organizationId: actor.organizationId,
      workspaceId,
      userId: actor.userId,
      recordAuditEvent: actor.recorderFor(workspaceId),
      buffer: bytes.value,
      fileName: document.fileName,
      mimeType: document.format === "pdf" ? PDF_MIME_TYPE : DOCX_MIME_TYPE,
      encryption: serverBuiltFileEncryption(),
      ...(dependencies.documents === undefined
        ? {}
        : { dependencies: dependencies.documents }),
    });
    if (Result.isError(created)) {
      return Result.err(
        seedError(`document ${document.fileName}`, created.error),
      );
    }
    counts.documents.created += 1;
    return Result.ok(undefined);
  });
};

const seedTasks = async ({
  actor,
  workspaceId,
  matter,
  counts,
}: MatterStep): Promise<Result<void, ReviewSeedError>> => {
  const taskIds = matter.tasks.map((task) =>
    reviewSampleId<"entity">(
      actor.organizationId,
      `task:${matter.key}:${task.key}`,
    ),
  );
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          inArray(entities.id, taskIds),
        ),
      )
      .limit(taskIds.length),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("tasks", existing.error));
  }
  const existingIds = new Set(existing.value.map(({ id }) => id));
  return await inOrder(matter.tasks.entries(), async ([index, task]) => {
    const entityId = taskIds[index];
    if (entityId === undefined || existingIds.has(entityId)) {
      counts.tasks.existing += 1;
      return Result.ok(undefined);
    }
    const created = await Result.gen(() =>
      createTaskEntityHandler({
        safeDb: actor.safeDb,
        workspaceId,
        userId: actor.userId,
        recordAuditEvent: actor.recorderFor(workspaceId),
        entityId,
        body: {
          name: task.name,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate,
        },
      }),
    );
    if (Result.isError(created)) {
      return Result.err(seedError(`task ${task.name}`, created.error));
    }
    counts.tasks.created += 1;
    return Result.ok(undefined);
  });
};

/**
 * A default rate table with one fallback rate per matter, through the same
 * writers the rate settings use, so sample time entries are billable as the
 * product's default entry is.
 */
const TIME_BILLING_FEATURE_ID = "time-billing";

const seedRateTable = async ({
  actor,
  workspaceId,
  counts,
}: MatterStep): Promise<Result<void, ReviewSeedError>> => {
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ id: rateTables.id })
      .from(rateTables)
      .where(
        and(
          eq(rateTables.workspaceId, workspaceId),
          eq(rateTables.isDefault, true),
        ),
      )
      .limit(1),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("rate table", existing.error));
  }
  if (existing.value.length > 0) {
    counts.rateTables.existing += 1;
    return Result.ok(undefined);
  }
  const recordAuditEvent = actor.recorderFor(workspaceId);
  const table = await Result.gen(() =>
    createRateTableHandler({
      safeDb: actor.safeDb,
      organizationId: actor.organizationId,
      workspaceId,
      body: {
        name: SAMPLE_RATE_TABLE.name,
        currency: SAMPLE_RATE_TABLE.currency,
        isDefault: true,
      },
      recordAuditEvent,
    }),
  );
  if (Result.isError(table)) {
    return Result.err(seedError("rate table", table.error));
  }
  const entry = await Result.gen(() =>
    createRateEntryHandler({
      safeDb: actor.safeDb,
      workspaceId,
      session: { activeOrganizationId: actor.organizationId },
      params: { rateTableId: table.value.id },
      body: {
        hourlyRate: SAMPLE_RATE_TABLE.hourlyRateMinor,
        effectiveFrom: SAMPLE_RATE_TABLE.effectiveFrom,
      },
      recordAuditEvent,
    }),
  );
  if (Result.isError(entry)) {
    return Result.err(seedError("rate entry", entry.error));
  }
  counts.rateTables.created += 1;
  return Result.ok(undefined);
};

/**
 * Turn on time billing for the review account through the self-serve toggle
 * the settings page uses. A deployment without time billing has nothing to
 * enable, and the seed goes on without it.
 */
const seedTimeBilling = async (
  actor: ReviewSeedActor,
  counts: ReviewSeedCounts,
): Promise<Result<void, ReviewSeedError>> => {
  if (
    !isDeploymentFeatureEnabled(
      FEATURE_REGISTRY[TIME_BILLING_FEATURE_ID].deploymentFeature,
    )
  ) {
    return Result.ok(undefined);
  }
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ featureId: featureEnrolments.featureId })
      .from(featureEnrolments)
      .where(
        and(
          eq(featureEnrolments.organizationId, actor.organizationId),
          eq(featureEnrolments.userId, actor.userId),
          eq(featureEnrolments.featureId, TIME_BILLING_FEATURE_ID),
        ),
      )
      .limit(1),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("time billing", existing.error));
  }
  if (existing.value.length > 0) {
    counts.enrolments.existing += 1;
    return Result.ok(undefined);
  }
  const enrolled = await Result.gen(() =>
    enrolFeatureHandler({
      safeDb: actor.safeDb,
      organizationId: actor.organizationId,
      userId: actor.userId,
      featureId: TIME_BILLING_FEATURE_ID,
      recordAuditEvent: actor.recorderFor(null),
    }),
  );
  if (Result.isError(enrolled)) {
    return Result.err(seedError("time billing", enrolled.error));
  }
  counts.enrolments.created += 1;
  return Result.ok(undefined);
};

const SAMPLE_TIME_ZONE = "Europe/Prague";

const seedTimeEntries = async ({
  actor,
  workspaceId,
  matter,
  counts,
}: MatterStep): Promise<Result<void, ReviewSeedError>> => {
  const narratives = matter.timeEntries.map(({ narrative }) => narrative);
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ narrative: timeEntries.narrative })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.organizationId, actor.organizationId),
          eq(timeEntries.workspaceId, workspaceId),
          inArray(timeEntries.narrative, narratives),
        ),
      )
      .limit(narratives.length),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("time entries", existing.error));
  }
  const existingNarratives = new Set(
    existing.value.map(({ narrative }) => narrative),
  );
  return await inOrder(matter.timeEntries, async (entry) => {
    if (existingNarratives.has(entry.narrative)) {
      counts.timeEntries.existing += 1;
      return Result.ok(undefined);
    }
    const created = await Result.gen(() =>
      createTimeEntryHandler({
        safeDb: actor.safeDb,
        organizationId: actor.organizationId,
        workspaceId,
        userId: actor.userId,
        memberRole: actor.memberAuthority,
        recordAuditEvent: actor.recorderFor(workspaceId),
        body: {
          dateWorked: entry.dateWorked,
          timezoneId: SAMPLE_TIME_ZONE,
          durationMinutes: entry.durationMinutes,
          narrative: entry.narrative,
        },
      }),
    );
    if (Result.isError(created)) {
      return Result.err(seedError("time entry", created.error));
    }
    counts.timeEntries.created += 1;
    return Result.ok(undefined);
  });
};

const seedMatters = async (
  actor: ReviewSeedActor,
  dependencies: ReviewSeedDependencies,
  counts: ReviewSeedCounts,
): Promise<Result<void, ReviewSeedError>> => {
  const matterIds = SAMPLE_MATTERS.map((matter) =>
    reviewSampleId<"workspace">(actor.organizationId, `matter:${matter.key}`),
  );
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.organizationId, actor.organizationId),
          inArray(workspaces.id, matterIds),
        ),
      )
      .limit(matterIds.length),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("matters", existing.error));
  }
  const existingIds = new Set(existing.value.map(({ id }) => id));
  return await inOrder(SAMPLE_MATTERS.entries(), async ([index, matter]) => {
    const workspaceId = matterIds[index];
    if (workspaceId === undefined) {
      return Result.ok(undefined);
    }
    if (existingIds.has(workspaceId)) {
      counts.matters.existing += 1;
    } else {
      const created = await Result.gen(() =>
        createWorkspaceHandler({
          userEmail: actor.userEmail,
          safeDb: actor.safeDb,
          organizationId: actor.organizationId,
          userId: actor.userId,
          recordAuditEvent: actor.recorderFor(null),
          body: {
            id: workspaceId,
            name: matter.name,
            filePropertyName: "File",
            clientId: reviewSampleId<"contact">(
              actor.organizationId,
              `contact:${matter.clientKey}`,
            ),
          },
        }),
      );
      if (Result.isError(created)) {
        return Result.err(seedError(`matter ${matter.name}`, created.error));
      }
      counts.matters.created += 1;
    }
    const matterStep = { actor, workspaceId, matter, dependencies, counts };
    // The rate table comes before the time entries it prices.
    return await inOrder(
      [seedDocuments, seedTasks, seedRateTable, seedTimeEntries],
      async (step) => await step(matterStep),
    );
  });
};

const seedClauses = async (
  actor: ReviewSeedActor,
  counts: ReviewSeedCounts,
): Promise<Result<void, ReviewSeedError>> => {
  const titles = SAMPLE_CLAUSES.map(({ title }) => title);
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ title: clauses.title })
      .from(clauses)
      .where(
        and(
          eq(clauses.organizationId, actor.organizationId),
          inArray(clauses.title, titles),
        ),
      )
      .limit(titles.length),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("clauses", existing.error));
  }
  const existingTitles = new Set(existing.value.map(({ title }) => title));
  return await inOrder(SAMPLE_CLAUSES, async (clause) => {
    if (existingTitles.has(clause.title)) {
      counts.clauses.existing += 1;
      return Result.ok(undefined);
    }
    const created = await Result.gen(() =>
      createClauseHandler({
        safeDb: actor.safeDb,
        organizationId: actor.organizationId,
        userId: actor.userId,
        recordAuditEvent: actor.recorderFor(null),
        body: {
          title: clause.title,
          language: clause.language,
          description: clause.description,
          body: clause.paragraphs.map((text) => ({ text })),
        },
      }),
    );
    if (Result.isError(created)) {
      return Result.err(seedError(`clause ${clause.title}`, created.error));
    }
    counts.clauses.created += 1;
    return Result.ok(undefined);
  });
};

const seedTemplate = async (
  actor: ReviewSeedActor,
  counts: ReviewSeedCounts,
): Promise<Result<void, ReviewSeedError>> => {
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ id: templates.id })
      .from(templates)
      .where(
        and(
          eq(templates.organizationId, actor.organizationId),
          eq(templates.name, SAMPLE_TEMPLATE.name),
        ),
      )
      .limit(1),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("template", existing.error));
  }
  if (existing.value.length > 0) {
    counts.templates.existing += 1;
    return Result.ok(undefined);
  }
  const docx = await markdownToStellaDocx(SAMPLE_TEMPLATE.body);
  if (Result.isError(docx)) {
    return Result.err(seedError("template", docx.error));
  }
  // Server-built bytes are stored like any upload: scanned first.
  const scanned = await scanUploadForHandler({
    bytes: docx.value,
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: SAMPLE_TEMPLATE.fileName,
  });
  if (Result.isError(scanned)) {
    return Result.err(seedError("template", scanned.error));
  }
  const created = await Result.gen(() =>
    createStoredTemplate({
      safeDb: actor.safeDb,
      organizationId: actor.organizationId,
      userId: actor.userId,
      file: scanned.value,
      name: SAMPLE_TEMPLATE.name,
      fileName: SAMPLE_TEMPLATE.fileName,
      recordAuditEvent: actor.recorderFor(null),
    }),
  );
  if (Result.isError(created)) {
    return Result.err(seedError("template", created.error));
  }
  counts.templates.created += 1;
  return Result.ok(undefined);
};

const samplePlaybookPositions = (
  organizationId: SafeId<"organization">,
): PlaybookPositions => ({
  version: 3,
  items: SAMPLE_PLAYBOOK.positions.map((position): Position => ({
    mode: "graded",
    sourceId: reviewSampleId(
      organizationId,
      `playbook:${SAMPLE_PLAYBOOK.key}:${position.key}`,
    ),
    issue: position.issue,
    severity: position.severity,
    // A manual question: the playbook is stored without any model call.
    ask: {
      mode: "manual",
      question: position.question,
      content: { version: 1, type: "text" },
    },
    standard: {
      source: "tiers",
      tiers: {
        acceptable: {
          rules: [],
          ideal: { source: "inline", text: position.ideal },
        },
        fallback: {
          entries: [
            {
              id: reviewSampleId(
                organizationId,
                `playbook:${SAMPLE_PLAYBOOK.key}:${position.key}:fallback`,
              ),
              text: position.fallback,
            },
          ],
        },
        notAcceptable: {
          rules: [
            {
              id: reviewSampleId(
                organizationId,
                `playbook:${SAMPLE_PLAYBOOK.key}:${position.key}:red-line`,
              ),
              text: position.redLine,
            },
          ],
        },
      },
    },
    enabled: true,
  })),
});

const seedPlaybook = async (
  actor: ReviewSeedActor,
  counts: ReviewSeedCounts,
): Promise<Result<void, ReviewSeedError>> => {
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ id: playbookDefinitions.id })
      .from(playbookDefinitions)
      .where(
        and(
          eq(playbookDefinitions.organizationId, actor.organizationId),
          eq(playbookDefinitions.name, SAMPLE_PLAYBOOK.name),
        ),
      )
      .limit(1),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("playbook", existing.error));
  }
  if (existing.value.length > 0) {
    counts.playbooks.existing += 1;
    return Result.ok(undefined);
  }
  const created = await Result.gen(() =>
    createPlaybookDefinitionHandler({
      safeDb: actor.safeDb,
      organizationId: actor.organizationId,
      accessibleWorkspaceIds: [],
      // Every position asks a manual question, so no model is consulted.
      orgAIConfig: null,
      managedAIResidency: DEFAULT_MANAGED_AI_RESIDENCY,
      orgAIConfigStatus: "ok",
      promptCachingEnabled: false,
      recordAuditEvent: actor.recorderFor(null),
      body: {
        name: SAMPLE_PLAYBOOK.name,
        description: SAMPLE_PLAYBOOK.description,
        positions: samplePlaybookPositions(actor.organizationId),
      },
      origin: { type: "authored" },
    }),
  );
  if (Result.isError(created)) {
    return Result.err(seedError("playbook", created.error));
  }
  counts.playbooks.created += 1;
  return Result.ok(undefined);
};

/**
 * Fill the review organization with its fictional sample data. Idempotent:
 * every item has a stable identity (a derived id, or a name unique within its
 * scope), and a rerun writes only what is missing, so an interrupted run
 * completes on the next one.
 */
export const seedReviewOrganization = async (
  actor: ReviewSeedActor,
  dependencies: ReviewSeedDependencies = {},
): Promise<Result<ReviewSeedCounts, ReviewSeedError>> => {
  const counts = emptyCounts();
  // Contacts first: the matters name them as clients.
  const steps = [
    // The default document-type taxonomy an organization starts with; the
    // reset clears the organization's types with everything else.
    async () =>
      Result.mapError(
        await actor.safeDb(
          async (tx) =>
            await ensureDefaultDocumentTypes(actor.organizationId, tx),
        ),
        (cause) => seedError("document types", cause),
      ),
    async () => await seedTimeBilling(actor, counts),
    async () => await seedContacts(actor, counts),
    async () => await seedMatters(actor, dependencies, counts),
    async () => await seedClauses(actor, counts),
    async () => await seedTemplate(actor, counts),
    async () => await seedPlaybook(actor, counts),
  ];
  // The steps depend on each other's rows and stop at the first failure.
  const outcome = await inOrder(steps, async (step) => await step());
  return Result.isError(outcome) ? outcome : Result.ok(counts);
};
