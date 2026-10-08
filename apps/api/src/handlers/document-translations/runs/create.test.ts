import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { documentTranslationRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  DOCUMENT_TRANSLATION_COMMENT_POLICY,
  DOCUMENT_TRANSLATION_ENGINE,
  DOCUMENT_TRANSLATION_OUTPUT,
} from "@/api/lib/document-translation/contract";
import { authorizeOperation } from "@/api/lib/proofs/checked-transaction";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createDocumentTranslationRunHandler } from "./create";

type TranslationContext = Parameters<
  ReturnType<typeof createDocumentTranslationRunHandler>["handler"]
>[0];

test("translation insertion and audit keep checked values when the original body changes during preflight", async () => {
  const entityId = toSafeId<"entity">("translation_entity");
  const fieldId = toSafeId<"field">("translation_field");
  const entityVersionId = toSafeId<"entityVersion">("translation_version");
  const sourceFileId = toSafeId<"userFile">("translation_file");
  const checkedBody = {
    entityId,
    fieldId,
    entityVersionId,
    engine: DOCUMENT_TRANSLATION_ENGINE.AI,
    output: DOCUMENT_TRANSLATION_OUTPUT.BILINGUAL,
    targetLang: "CS",
    commentPolicy: DOCUMENT_TRANSLATION_COMMENT_POLICY.ORIGINAL,
  } as const satisfies TranslationContext["body"];
  const changedBody = {
    entityId: toSafeId<"entity">("substituted_entity"),
    fieldId: toSafeId<"field">("substituted_field"),
    engine: DOCUMENT_TRANSLATION_ENGINE.DEEPL,
    output: DOCUMENT_TRANSLATION_OUTPUT.TRANSLATED,
    targetLang: "DE",
    commentPolicy: DOCUMENT_TRANSLATION_COMMENT_POLICY.TRANSLATED,
  } as const satisfies TranslationContext["body"];
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const original = Promise.withResolvers<TranslationContext["body"]>();
  const inserted: (typeof documentTranslationRuns.$inferInsert)[] = [];
  const auditMetadata: unknown[] = [];
  let handoffs = 0;
  const { safeDb, scopedDb } = createScopedDbMock({
    query: {
      entities: {
        findFirst: async () => ({
          currentVersionId: entityVersionId,
          readOnly: false,
        }),
      },
      entityVersions: {
        findFirst: async () => ({
          id: entityVersionId,
          fields: [
            {
              id: fieldId,
              propertyId: toSafeId<"property">("translation_property"),
              content: {
                type: "file",
                id: sourceFileId,
                fileName: "agreement.docx",
                mimeType: DOCX_MIME_TYPE,
                sizeBytes: 1024,
                encrypted: false,
              },
            },
          ],
        }),
      },
    },
    insert: (table: unknown) => {
      expect(table).toBe(documentTranslationRuns);
      return {
        values: (value: typeof documentTranslationRuns.$inferInsert) => {
          inserted.push(value);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: value.id }],
            }),
          };
        },
      };
    },
  });
  const endpoint = createDocumentTranslationRunHandler({
    authorizeUsage: async (input) => {
      // The public handler clones its context; mutate the actual binding passed
      // to the usage authorizer, after its checked snapshot has been captured.
      original.resolve(
        asTestRaw<TranslationContext["body"]>(Reflect.get(input, "body")),
      );
      return await authorizeOperation({
        kind: "ConditionalUsageAllowed",
        input,
        check: async () => {
          entered.resolve(undefined);
          await release.promise;
          return Result.ok(undefined);
        },
      });
    },
    handoff: async () => {
      handoffs += 1;
    },
  });
  const context = createTestHandlerContext<TranslationContext>({
    body: { ...checkedBody },
    safeDb,
    scopedDb,
    createAuditRecorder: () =>
      auditRecorderDouble((events) => {
        for (const event of events) {
          auditMetadata.push(event.metadata);
        }
      }),
  });
  const pending = endpoint.handler(context);
  await entered.promise;
  const mutableBody = await original.promise;
  Object.assign(mutableBody, changedBody);
  expect(mutableBody).toMatchObject(changedBody);
  expect(inserted).toHaveLength(0);
  release.resolve(undefined);
  const result = await pending;
  expect(result).toMatchObject({ type: "started" });
  expect(inserted).toHaveLength(1);
  const run = inserted.at(0) ?? panic("Translation did not insert a run");
  expect(run).toMatchObject({
    organizationId: context.session.activeOrganizationId,
    workspaceId: context.workspaceId,
    entityId,
    fileFieldId: fieldId,
    entityVersionId,
    sourceFileId,
    sourceFileName: "agreement.docx",
    sourceMimeType: DOCX_MIME_TYPE,
    sourceLang: "auto",
    engine: checkedBody.engine,
    output: checkedBody.output,
    targetLang: checkedBody.targetLang,
    commentPolicy: checkedBody.commentPolicy,
    requestedBy: context.user.id,
  });
  expect(auditMetadata).toEqual([
    {
      entityId,
      engine: checkedBody.engine,
      output: checkedBody.output,
      targetLang: checkedBody.targetLang,
      commentPolicy: checkedBody.commentPolicy,
    },
  ]);
  expect(handoffs).toBe(1);
});
