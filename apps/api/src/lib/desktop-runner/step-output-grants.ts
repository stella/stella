import {
  CHAT_LOCAL_RUN_STEP_OUTPUT_GRANT_SECONDS,
  type ChatLocalRunStepOutputGrant,
  chatLocalRunStepOutputGrantMessage,
} from "@stll/api-contract/chat-local-run-step-output";

/**
 * What a run's steps produced stays on the member's computer
 * (`chat-local-run-step-output`); the API only lets the run's owner read it
 * there. Each run has an output key, derived here from the deployment's
 * secret and the run id, so nothing is stored: `run.start` hands it to the
 * computer, which keeps it beside the run's outputs, and a grant is a key
 * derived from it for one member, organization and expiry. The computer
 * derives the same key from its own linked account and checks each request's
 * signature with it.
 */

const OUTPUT_KEY_SCOPE = "stella.run-output-key.v1";

const hmacHex = (key: string, message: string) =>
  new Bun.CryptoHasher("sha256", key).update(message).digest("hex");

/** The output key of run `runId`, under the deployment's `secret`. */
export const runOutputKey = (secret: string, runId: string): string =>
  hmacHex(secret, `${OUTPUT_KEY_SCOPE}\n${runId}`);

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
