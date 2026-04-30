import { Result } from "better-result";

import { infoSoudTrackedCases } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  buildInfoSoudAgendaItems,
  importInfoSoudAgendaItems,
} from "@/api/lib/infosoud/agenda-import";
import { LIMITS } from "@/api/lib/limits";

import {
  createInfoSoudClient,
  infosoudLookupBodySchema,
  toInfoSoudLookupError,
} from "./infosoud-common";

const config = {
  body: infosoudLookupBodySchema,
  permissions: { entity: ["create"] },
} satisfies HandlerConfig;

const infosoudImportAgenda = createSafeHandler(
  config,
  async function* ({ body, request, safeDb, user, workspaceId }) {
    const courtCode = body.courtCode.trim();
    const spisZn = body.spisZn.trim();
    const lookupResult = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const client = createInfoSoudClient();
          return await client.searchCaseWithHearings({
            courtCode,
            signal: request.signal,
            spisZn,
          });
        },
        catch: toInfoSoudLookupError,
      }),
    );

    const agendaItems = buildInfoSoudAgendaItems(
      lookupResult.case,
      lookupResult.hearings.udalosti,
    );

    if (agendaItems.length > LIMITS.infoSoudAgendaImportItemsMax) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "InfoSoud agenda import limit reached",
        }),
      );
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const importResult = await importInfoSoudAgendaItems({
          actorUserId: user.id,
          agendaItems,
          tx,
          workspaceId,
        });

        if (!importResult.ok) {
          return importResult;
        }

        await tx
          .insert(infoSoudTrackedCases)
          .values({
            courtCode,
            createdBy: user.id,
            enabled: true,
            lastSyncError: null,
            lastSyncAttemptAt: new Date(),
            lastSyncedAt: new Date(),
            spisZn,
            workspaceId,
          })
          .onConflictDoUpdate({
            target: [
              infoSoudTrackedCases.workspaceId,
              infoSoudTrackedCases.courtCode,
              infoSoudTrackedCases.spisZn,
            ],
            set: {
              enabled: true,
              lastSyncError: null,
              lastSyncAttemptAt: new Date(),
              lastSyncedAt: new Date(),
            },
          });

        return importResult;
      }),
    );

    if (!result.ok) {
      return Result.err(
        new HandlerError({
          status: result.status,
          message: result.message,
        }),
      );
    }

    return Result.ok({
      created: result.created,
      skipped: result.skipped,
      total: result.total,
    });
  },
);

export default infosoudImportAgenda;
