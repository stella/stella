import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { actor } from "rivetkit";

import { getSyncActorConfig } from "@stella/rivet/actors/sync-actor-config";

import { isMockAI } from "@/api/consts";
import { db } from "@/api/db";
import { justifications } from "@/api/db/schema";
import type { Registry } from "@/api/handlers/registry";
import { generateBBoxes } from "@/api/handlers/registry/actors/b-box/generate-b-boxes";
import { generateBBoxesMock } from "@/api/handlers/registry/actors/b-box/generate-b-boxes-mock";
import { prepareJustificationData } from "@/api/handlers/registry/actors/b-box/generate-b-boxes-shared";
import {
  generateBBoxesSchema,
  type GenerateBBoxesSchema,
} from "@/api/handlers/registry/actors/b-box/schema";
import {
  broadcastEvent,
  validateActorInput,
  validateActorSession,
} from "@/api/handlers/registry/utils";
import { captureActorError } from "@/api/lib/errors/actions";

export const bBoxActor = actor({
  state: {
    pendingJustificationIds: new Set<string>(),
  },
  createConnState: (c, params) => validateActorSession(c.key, params),
  onWake: (c) => {
    // clear pending when actor wakes up if some jobs got stuck
    c.state.pendingJustificationIds = new Set<string>();
  },
  actions: {
    generateBBoxes: async (c, input: GenerateBBoxesSchema) => {
      const requestId = nanoid();
      const { queryKey, justificationId } = validateActorInput(
        generateBBoxesSchema,
        input,
      );
      const { organizationId, workspaceId, authToken } = c.conn.state;

      if (c.state.pendingJustificationIds.has(justificationId)) {
        return { status: "already-running" };
      }

      c.state.pendingJustificationIds.add(justificationId);

      broadcastEvent(c, {
        name: "b-box-status",
        data: { status: "pending", justificationId },
      });

      const nestedResult = await Result.tryPromise(async () => {
        const preparedDataResult = await prepareJustificationData(
          organizationId,
          workspaceId,
          justificationId,
        );
        if (Result.isError(preparedDataResult)) {
          return preparedDataResult;
        }
        const preparedData = preparedDataResult.value;

        const generateFn = isMockAI() ? generateBBoxesMock : generateBBoxes;
        const bBoxes = await Promise.all(
          preparedData.pageNumbers.map((pageNumber) =>
            generateFn({
              abortSignal: c.abortSignal,
              data: {
                pdf: preparedData.pdf,
                pageNumber,
                prompt: preparedData.prompt,
                fieldContent: preparedData.fieldContent,
                justificationText: preparedData.justificationText,
              },
            }),
          ),
        );

        const boxes = bBoxes.flat();

        await db
          .update(justifications)
          .set({
            boundingBoxes: {
              version: 1,
              boxes,
            },
          })
          .where(eq(justifications.id, justificationId));

        const client = c.client<Registry>();

        const syncActor = client.sync.getOrCreate(
          ...getSyncActorConfig({
            type: "vanilla",
            organizationId,
            authToken,
          }),
        );

        await syncActor.invalidateQuery(queryKey);

        return Result.ok(boxes);
      });

      const result = Result.flatten(nestedResult);

      c.state.pendingJustificationIds.delete(justificationId);

      if (result.isErr()) {
        captureActorError({
          c,
          requestId,
          error: result.error,
          metadata: { justificationId },
        });

        broadcastEvent(c, {
          name: "b-box-status",
          data: { status: "error", justificationId },
        });

        return { status: "error" };
      }

      broadcastEvent(c, {
        name: "b-box-status",
        data: { status: "completed", justificationId },
      });

      return { status: "completed" };
    },
    destroy: (c): { success: true } | { success: false; message: string } => {
      if (c.state.pendingJustificationIds.size > 0) {
        return {
          success: false,
          message: "Cannot destroy while bounding box generation is running",
        };
      }

      c.destroy();

      return { success: true };
    },
  },
});
