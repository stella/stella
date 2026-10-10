import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import {
  clauses,
  contacts,
  entities,
  playbookDefinitions,
  templates,
  workspaces,
} from "@/api/db/schema";
import { createClauseHandler } from "@/api/handlers/clauses/create";
import { createContactHandler } from "@/api/handlers/contacts/create";
import { createPlaybookDefinitionHandler } from "@/api/handlers/playbooks/create-shared";
import { createWorkspaceHandler } from "@/api/handlers/workspaces/create";
import type { SafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import { ensureDefaultDocumentTypes } from "@/api/lib/document-types/defaults";
import { markdownToStellaDocx } from "@/api/lib/docx-authoring/from-markdown";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload-handler";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { createTextPdf } from "@/api/lib/files/text-pdf";
import { createModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import { inOrder } from "@/api/lib/review-organization/in-order";
import {
  SAMPLE_CLAUSES,
  SAMPLE_CONTACTS,
  SAMPLE_MATTERS,
  SAMPLE_PLAYBOOK,
  SAMPLE_TEMPLATE,
} from "@/api/lib/review-organization/sample-data";
import type {
  SampleContact,
  SampleDocument,
} from "@/api/lib/review-organization/sample-data";
import {
  emptyCounts,
  reviewSampleId,
  seedError,
} from "@/api/lib/review-organization/seed-common";
import type {
  MatterStep,
  ReviewSeedActor,
  ReviewSeedCounts,
  ReviewSeedDependencies,
  ReviewSeedError,
} from "@/api/lib/review-organization/seed-common";
import {
  seedMatterTimeBilling,
  seedTimeBillingEnrolment,
} from "@/api/lib/review-organization/time-billing-seed";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";
import { createStoredTemplate } from "@/api/lib/templates/create-template";
import type {
  PlaybookPositions,
  Position,
} from "@/api/lib/workflow/playbook-positions";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

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
  return await inOrder(
    bodies,
    async (body) => {
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
    },
    actor.cancelled,
  );
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
  return await inOrder(
    matter.documents,
    async (document) => {
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
    },
    actor.cancelled,
  );
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
  return await inOrder(
    matter.tasks.entries(),
    async ([index, task]) => {
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
    },
    actor.cancelled,
  );
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
  return await inOrder(
    SAMPLE_MATTERS.entries(),
    async ([index, matter]) => {
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
        [seedDocuments, seedTasks, seedMatterTimeBilling],
        async (step) => await step(matterStep),
        actor.cancelled,
      );
    },
    actor.cancelled,
  );
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
  return await inOrder(
    SAMPLE_CLAUSES,
    async (clause) => {
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
    },
    actor.cancelled,
  );
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
      admitModelAction: createModelActionAdmitter({
        organizationId: actor.organizationId,
        userId: actor.userId,
        organizationStateDb: actor.scopedDb,
        actionKind: "playbooks.derive-ask",
      }),
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
    async () => await seedTimeBillingEnrolment(actor, counts, dependencies),
    async () => await seedContacts(actor, counts),
    async () => await seedMatters(actor, dependencies, counts),
    async () => await seedClauses(actor, counts),
    async () => await seedTemplate(actor, counts),
    async () => await seedPlaybook(actor, counts),
  ];
  // The steps depend on each other's rows and stop at the first failure.
  const outcome = await inOrder(
    steps,
    async (step) => await step(),
    actor.cancelled,
  );
  return Result.isError(outcome) ? outcome : Result.ok(counts);
};
