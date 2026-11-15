import { Result } from "better-result";

import {
  CHAT_LOCAL_RUN_STEP_OUTPUT_GRANT_SECONDS,
  type ChatLocalRunStepOutputGrant,
  chatLocalRunStepOutputGrantMessage,
} from "@stll/api-contract/chat-local-run-step-output";

import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { RunOwner } from "@/api/lib/desktop-runner/store";
import type { DatabaseError } from "@/api/lib/errors/tagged-errors";

/**
 * What a run's steps produced stays on the member's computer
 * (`chat-local-run-step-output`); the API only lets the run's owner read it
 * there. A grant is a key signed with the run's own output key
 * (`output-keys.ts`) for one member, organization and expiry. The computer
 * got that output key in `run.start`, keeps it beside the run's outputs, and
 * signs the same message from its own linked account to check each request.
 */

const hmacHex = (key: string, message: string) =>
  new Bun.CryptoHasher("sha256", key).update(message).digest("hex");

type StepOutputGrantOptions = {
  outputKey: string;
  runId: string;
  owner: { userId: string; organizationId: string };
  /** Unix seconds. */
  now: number;
};

/** A grant for the run's owner to read its step outputs on the computer. */
export const stepOutputGrant = ({
  outputKey,
  runId,
  owner,
  now,
}: StepOutputGrantOptions): ChatLocalRunStepOutputGrant => {
  const expiresAt = now + CHAT_LOCAL_RUN_STEP_OUTPUT_GRANT_SECONDS;
  return {
    key: hmacHex(
      outputKey,
      chatLocalRunStepOutputGrantMessage({
        runId,
        userId: owner.userId,
        organizationId: owner.organizationId,
        expiresAt,
      }),
    ),
    expiresAt,
  };
};

type OwnerStepOutputGrantOptions = {
  control: Pick<DesktopRunnerControl, "readRunOutputKey">;
  owner: RunOwner;
  runId: string;
  /** Unix seconds. */
  now: number;
};

/**
 * A grant for `owner` to read run `runId`'s step outputs, signed with the
 * key stored with the run; `null` when the run is not theirs or keeps no key.
 */
export const ownerStepOutputGrant = async ({
  control,
  owner,
  runId,
  now,
}: OwnerStepOutputGrantOptions): Promise<
  Result<ChatLocalRunStepOutputGrant | null, DatabaseError>
> => {
  const outputKey = await control.readRunOutputKey({ owner, runId });
  if (outputKey.isErr()) {
    return Result.err(outputKey.error);
  }
  return Result.ok(
    outputKey.value === null
      ? null
      : stepOutputGrant({ outputKey: outputKey.value, runId, owner, now }),
  );
};
