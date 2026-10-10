import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import {
  REQUEST_SECRET_TOOL_NAME,
  requestSecretInputSchema,
  requestSecretOutputSchema,
} from "@stll/api-contract/chat-secret";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatSecrets } from "@/api/db/schema";
import type { ChatPart } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ValidatePrivateReceiptsOptions = {
  parts: readonly ChatPart[];
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

export const validatePrivateReceipts = async ({
  parts,
  safeDb,
  threadId,
  userId,
}: ValidatePrivateReceiptsOptions): Promise<
  Result<void, HandlerError<400> | SafeDbError>
> => {
  const calls = parts.filter(
    (part) =>
      part.type === "tool-call" &&
      part.name === REQUEST_SECRET_TOOL_NAME &&
      part.output !== undefined,
  );
  if (calls.length === 0) {
    return Result.ok(undefined);
  }
  const result = await safeDb(async (tx) => {
    const callIds = calls.flatMap((call) =>
      call.type === "tool-call" ? [call.id] : [],
    );
    const rows = await tx
      .select({
        toolCallId: chatSecrets.toolCallId,
        id: chatSecrets.id,
        status: chatSecrets.decision,
        slug: chatSecrets.targetSlug,
      })
      .from(chatSecrets)
      .where(
        and(
          eq(chatSecrets.threadId, threadId),
          eq(chatSecrets.userId, userId),
          inArray(chatSecrets.toolCallId, callIds),
        ),
      )
      .limit(calls.length);
    return calls.every((call) => {
      if (call.type !== "tool-call") {
        return false;
      }
      const output = v.safeParse(requestSecretOutputSchema, call.output);
      const input = v.safeParse(requestSecretInputSchema, call.input);
      if (
        !output.success ||
        !input.success ||
        input.output.target.connectorSlug !== output.output.target.connectorSlug
      ) {
        return false;
      }
      return rows.some(
        (row) =>
          row.toolCallId === call.id &&
          row.slug === output.output.target.connectorSlug &&
          row.status === output.output.status &&
          (output.output.status === "declined" ||
            row.id === output.output.secretRef),
      );
    });
  });
  if (result.isErr()) {
    return Result.err(result.error);
  }
  if (!result.value) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Private input receipt is invalid",
      }),
    );
  }
  return Result.ok(undefined);
};
