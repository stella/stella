import { Result } from "better-result";

import { EXTRA_COURTS } from "@stll/infosoud";

import type { ScopedDb } from "@/api/db/safe-db";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { projectionPayload } from "@/api/lib/projection-totality";

import {
  collectVocabulary,
  VOCABULARY_LIMITS,
  vocabularyResponseSchema,
} from "./candidates";
import type { VocabularySource } from "./candidates";

type ReadVocabularyOptions = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
};

export const readVocabularyHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
}: ReadVocabularyOptions) =>
  await scopedDb(async (tx) => {
    const matter = await tx.query.workspaces.findFirst({
      where: {
        id: { eq: workspaceId },
        organizationId: { eq: organizationId },
      },
      columns: { name: true, reference: true, lastActivityAt: true },
      with: {
        client: {
          columns: { displayName: true, type: true, updatedAt: true },
          where: { organizationId: { eq: organizationId } },
        },
      },
    });
    if (!matter) {
      return status(404);
    }

    // Every relation is read under the request's RLS context. In particular,
    // document feature gates apply before the recent-title sample is limited.
    const [linkedContacts, documents, cases] = await Promise.all([
      tx.query.workspaceContacts.findMany({
        where: {
          workspaceId: { eq: workspaceId },
          organizationId: { eq: organizationId },
        },
        columns: { role: true, createdAt: true },
        orderBy: { createdAt: "desc", id: "desc" },
        limit: VOCABULARY_LIMITS.contacts,
        with: {
          contact: {
            columns: { displayName: true, type: true, updatedAt: true },
            where: { organizationId: { eq: organizationId } },
          },
        },
      }),
      tx.query.entities.findMany({
        where: { workspaceId: { eq: workspaceId }, kind: { eq: "document" } },
        columns: { name: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: "desc", id: "desc" },
        limit: VOCABULARY_LIMITS.perKind,
      }),
      tx.query.infoSoudTrackedCases.findMany({
        where: { workspaceId: { eq: workspaceId } },
        columns: { spisZn: true, courtCode: true, updatedAt: true },
        orderBy: { id: "desc" },
        limit: VOCABULARY_LIMITS.perKind,
      }),
    ]);

    const sources: VocabularySource[] = [
      {
        term: matter.name,
        kind: "matter-name",
        lastUsedAt: matter.lastActivityAt,
      },
      {
        term: matter.reference,
        kind: "case-number",
        lastUsedAt: matter.lastActivityAt,
      },
    ];
    if (matter.client) {
      sources.push(
        {
          term: matter.client.displayName,
          kind: "party",
          lastUsedAt: matter.client.updatedAt,
        },
        {
          term: matter.client.displayName,
          kind: matter.client.type,
          lastUsedAt: matter.client.updatedAt,
        },
      );
    }
    for (const { contact, role } of linkedContacts) {
      if (!contact) {
        continue;
      }
      sources.push({
        term: contact.displayName,
        kind: contact.type,
        lastUsedAt: contact.updatedAt,
      });
      if (role === "opposing_party" || role === "third_party") {
        sources.push({
          term: contact.displayName,
          kind: "party",
          lastUsedAt: contact.updatedAt,
        });
      }
    }
    for (const document of documents) {
      sources.push({
        term: document.name,
        kind: "document-title",
        lastUsedAt: document.updatedAt ?? document.createdAt,
      });
    }
    for (const trackedCase of cases) {
      const courtName = EXTRA_COURTS[trackedCase.courtCode];
      if (courtName !== undefined) {
        sources.push({
          term: courtName,
          kind: "court",
          lastUsedAt: trackedCase.updatedAt,
        });
      }
      sources.push({
        term: trackedCase.spisZn,
        kind: "case-number",
        lastUsedAt: trackedCase.updatedAt,
      });
    }
    return projectionPayload(vocabularyResponseSchema, {
      candidates: collectVocabulary(sources),
    });
  });

const config = {
  contract: "patch",
  description: `Read a matter's names, references, linked contacts, tracked case numbers, locally known court names, and most recently created document titles. Returns up to ${VOCABULARY_LIMITS.perKind} candidates per kind and ${VOCABULARY_LIMITS.total} total; terms longer than ${VOCABULARY_LIMITS.termLength} characters are omitted. Candidates preserve spelling and include a kind weight and available activity timestamp. Requires a matter id; returns not found when unavailable.`,
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workspace_schema",
    consumesServices: false,
  },
  access: "read",
} satisfies WorkspaceHandlerConfig;

const readVocabulary = createSafeHandler(
  config,
  async function* ({ scopedDb, workspaceId, session }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readVocabularyHandler({
            scopedDb,
            workspaceId,
            organizationId: session.activeOrganizationId,
          }),
      ),
    );
    return Result.ok(response);
  },
);

export default readVocabulary;
