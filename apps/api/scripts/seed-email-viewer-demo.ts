/**
 * Add the representative email fixtures to the existing local email QA matter.
 * Rerunning is idempotent. Set STELLA_SEED_EMAIL_WORKSPACE_ID to target a
 * different matter that already has a file property.
 */

import { panic } from "better-result";
import { and, asc, desc, eq, gt, isNotNull, ne } from "drizzle-orm";

import {
  member as authMember,
  session as authSession,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  entities,
  entityVersions,
  extractedContent,
  fields,
  properties,
  workspaceMembers,
  workspaceViews,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import {
  EML_MIME_TYPE,
  parseEmail,
  parsedEmailToText,
} from "@/api/lib/files/email-to-html";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import { buildDefaultViewRows } from "@/api/lib/views";

import { createSeedEmail, SEED_EMAIL_FILE_NAMES } from "./seed-dev";
import { seedId } from "./seed-utils";

const EMAIL_QA_MATTER_NAME = "Email Viewer QA";
const EMAIL_QA_MATTER_REFERENCE = "DEV/EMAIL";
const IV_BYTES = 12;

const resolveTarget = async () => {
  const activeSessions = await rootDb
    .select({
      organizationId: authMember.organizationId,
      userId: authSession.userId,
    })
    .from(authSession)
    .innerJoin(
      authMember,
      and(
        eq(authMember.userId, authSession.userId),
        eq(authMember.organizationId, authSession.activeOrganizationId),
      ),
    )
    .where(
      and(
        isNotNull(authSession.activeOrganizationId),
        gt(authSession.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(authSession.updatedAt))
    .limit(1);
  const activeSession = activeSessions.at(0);
  const activeOrganizationIdValue = activeSession?.organizationId;
  if (!activeSession || !activeOrganizationIdValue) {
    panic(
      "No active local session found. Sign in to dev before seeding emails.",
    );
  }
  const activeOrganizationId = toSafeId<"organization">(
    activeOrganizationIdValue,
  );

  const explicitWorkspaceId =
    process.env["STELLA_SEED_EMAIL_WORKSPACE_ID"]?.trim();
  const workspaceRows = await rootDb
    .select({
      id: workspaces.id,
      organizationId: workspaces.organizationId,
      name: workspaces.name,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, activeSession.userId),
      ),
    )
    .where(
      and(
        ne(workspaces.status, "deleting"),
        explicitWorkspaceId
          ? and(
              eq(workspaces.id, toSafeId<"workspace">(explicitWorkspaceId)),
              eq(workspaces.organizationId, activeOrganizationId),
            )
          : and(
              eq(workspaces.name, EMAIL_QA_MATTER_NAME),
              eq(workspaces.organizationId, activeOrganizationId),
            ),
      ),
    )
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  const existingWorkspace = workspaceRows.at(0);
  if (!existingWorkspace && explicitWorkspaceId) {
    panic("The requested matter is not accessible in the active organization.");
  }

  const workspace = existingWorkspace ?? {
    id: seedId<"workspace">(
      `email-viewer-demo-${activeOrganizationId}-${activeSession.userId}-workspace`,
    ),
    organizationId: activeOrganizationId,
    name: EMAIL_QA_MATTER_NAME,
  };
  if (!existingWorkspace) {
    await rootDb.transaction(async (tx) => {
      const insertedWorkspaces = await tx
        .insert(workspaces)
        .values({
          id: workspace.id,
          organizationId: workspace.organizationId,
          name: workspace.name,
          reference: `${EMAIL_QA_MATTER_REFERENCE}/${workspace.id}`,
        })
        .onConflictDoNothing()
        .returning({ id: workspaces.id });
      if (!insertedWorkspaces.at(0)) {
        panic(
          "The email QA matter already exists but is not an eligible target.",
        );
      }
      await tx
        .insert(workspaceMembers)
        .values({
          id: seedId<"workspaceMember">(
            `email-viewer-demo-${workspace.id}-${activeSession.userId}-member`,
          ),
          workspaceId: workspace.id,
          userId: activeSession.userId,
        })
        .onConflictDoNothing();
    });
  }

  const filePropertyRows = await rootDb
    .select({ id: properties.id, content: properties.content })
    .from(properties)
    .where(eq(properties.workspaceId, workspace.id));
  const existingFileProperty = filePropertyRows.find(
    ({ content }) => content.type === "file",
  );
  const fileProperty =
    existingFileProperty ??
    ({
      id: seedId<"property">(`email-viewer-demo-${workspace.id}-file-property`),
    } as const);
  if (!existingFileProperty) {
    await rootDb.insert(properties).values({
      id: fileProperty.id,
      workspaceId: workspace.id,
      name: "Documents",
      status: "fresh",
      content: { version: 1, type: "file" },
      tool: { version: 1, type: "manual-input" },
      system: true,
      kinds: ["document"],
    });
  }

  const defaultViews = buildDefaultViewRows({
    workspaceId: workspace.id,
    filePropertyId: fileProperty.id,
  });
  const existingViews = await rootDb
    .select({ name: workspaceViews.name, layout: workspaceViews.layout })
    .from(workspaceViews)
    .where(eq(workspaceViews.workspaceId, workspace.id));
  const missingDefaultViews = defaultViews.filter(
    (defaultView) =>
      !existingViews.some(
        (existingView) => existingView.layout.type === defaultView.layout.type,
      ),
  );
  if (missingDefaultViews.length > 0) {
    await rootDb.insert(workspaceViews).values(missingDefaultViews);
  }

  return {
    filePropertyId: fileProperty.id,
    organizationId: activeOrganizationId,
    userId: activeSession.userId,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  };
};

const seedEmailViewerDemo = async () => {
  if (process.env.NODE_ENV === "production") {
    panic("Refusing to seed email fixtures in production.");
  }

  const target = await resolveTarget();
  for (const [index, fileName] of SEED_EMAIL_FILE_NAMES.entries()) {
    const entityId = seedId<"entity">(
      `email-viewer-demo-${target.workspaceId}-${fileName}-entity`,
    );
    const entityVersionId = seedId<"entityVersion">(
      `email-viewer-demo-${target.workspaceId}-${fileName}-version`,
    );
    const fieldId = seedId<"field">(
      `email-viewer-demo-${target.workspaceId}-${fileName}-field`,
    );
    const fileId = seedId<"userFile">(
      `email-viewer-demo-${target.workspaceId}-${fileName}-file`,
    );
    const content = createSeedEmail(fileName);
    const sha256Hex = new Bun.CryptoHasher("sha256")
      .update(content)
      .digest("hex");
    const createdAt = new Date(Date.UTC(2026, 6, 14 + index, 9, index * 7));

    await rootDb
      .insert(entities)
      .values({
        id: entityId,
        workspaceId: target.workspaceId,
        kind: "document",
        name: fileName,
        displayName: fileName,
        createdBy: target.userId,
        lastEditedBy: target.userId,
        createdAt,
        updatedAt: createdAt,
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: { name: fileName, displayName: fileName },
      });

    await rootDb
      .insert(entityVersions)
      .values({
        id: entityVersionId,
        workspaceId: target.workspaceId,
        entityId,
        createdBy: target.userId,
      })
      .onConflictDoNothing();
    await rootDb
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));

    const s3Key = `${target.organizationId}/${target.workspaceId}/${fileId}.eml`;
    await writeS3ObjectWithRetry({
      contentType: EML_MIME_TYPE,
      data: new Uint8Array(content),
      key: s3Key,
    });

    const fileContent = {
      version: 1,
      type: "file",
      id: fileId,
      fileName,
      mimeType: EML_MIME_TYPE,
      sizeBytes: content.length,
      encrypted: false,
      sha256Hex,
      pdfFileId: null,
      pdfDerivative: { status: "not-required" },
      thumbnailFileId: null,
      thumbnailDerivative: { status: "not-required" },
    } as const satisfies FieldContent;
    await rootDb
      .insert(fields)
      .values({
        id: fieldId,
        workspaceId: target.workspaceId,
        propertyId: target.filePropertyId,
        entityVersionId,
        fileId,
        content: fileContent,
      })
      .onConflictDoUpdate({ target: fields.id, set: { content: fileContent } });

    const extractedText = parsedEmailToText(
      await parseEmail(Uint8Array.from(content).buffer, EML_MIME_TYPE),
    );
    const extractionEnvelope = {
      ciphertext: Buffer.from(extractedText, "utf-8"),
      iv: Buffer.alloc(IV_BYTES),
    };
    await rootDb
      .insert(extractedContent)
      .values({
        entityId,
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        sourceEntityVersionId: entityVersionId,
        sourceFieldId: fieldId,
        sourceFileId: fileId,
        sourceSha256Hex: sha256Hex,
        ciphertext: extractionEnvelope.ciphertext,
        iv: extractionEnvelope.iv,
        charCount: extractedText.length,
        language: null,
        extractedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: extractedContent.entityId,
        set: {
          sourceEntityVersionId: entityVersionId,
          sourceFieldId: fieldId,
          sourceFileId: fileId,
          sourceSha256Hex: sha256Hex,
          ciphertext: extractionEnvelope.ciphertext,
          iv: extractionEnvelope.iv,
          charCount: extractedText.length,
          extractedAt: new Date(),
        },
      });
    await upsertSearchDocument(entityId);
  }

  console.log(
    `Seeded ${SEED_EMAIL_FILE_NAMES.length} emails into ${target.workspaceName} (${target.workspaceId}).`,
  );
};

await seedEmailViewerDemo();
