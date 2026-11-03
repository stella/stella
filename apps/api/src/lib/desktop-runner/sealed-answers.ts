import * as v from "valibot";

import {
  DESKTOP_RUNNER_SERVER_MESSAGE,
  type DesktopRunnerQuestionAnswers,
  desktopRunnerQuestionAnswersSchema,
  type DesktopRunnerServerMessage,
} from "@stll/api-contract/desktop-runner";

import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";

/**
 * A question's answers may hold what the member typed for a secret (a
 * password the harness asked for), and every queued command is kept until its
 * run is deleted, so a stored `run.answer` holds its answers encrypted for
 * the run's organization. They are opened only to compose the frame sent to
 * the computer, and never logged.
 */

export type RunAnswerMessage = Extract<
  DesktopRunnerServerMessage,
  { type: typeof DESKTOP_RUNNER_SERVER_MESSAGE.runAnswer }
>;

const base64Schema = v.pipe(v.string(), v.base64());

/** A `run.answer` as the command queue stores it. */
export const storedRunAnswerSchema = v.strictObject({
  type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.runAnswer),
  runId: v.pipe(v.string(), v.uuid()),
  requestId: v.pipe(v.string(), v.uuid()),
  sealedAnswers: v.strictObject({
    ciphertext: base64Schema,
    iv: base64Schema,
  }),
});
export type StoredRunAnswer = v.InferOutput<typeof storedRunAnswerSchema>;

export const sealRunAnswer = async (
  organizationId: SafeId<"organization">,
  { answers, ...message }: RunAnswerMessage,
): Promise<StoredRunAnswer> => {
  const sealed = await encryptContent(organizationId, JSON.stringify(answers));
  return {
    ...message,
    sealedAnswers: {
      ciphertext: sealed.ciphertext.toString("base64"),
      iv: sealed.iv.toString("base64"),
    },
  };
};

/** The frame a stored `run.answer` is sent as; `null` when it no longer opens. */
export const openRunAnswer = async (
  organizationId: SafeId<"organization">,
  { sealedAnswers, ...message }: StoredRunAnswer,
): Promise<RunAnswerMessage | null> => {
  const plaintext = await decryptContent(
    organizationId,
    Buffer.from(sealedAnswers.ciphertext, "base64"),
    Buffer.from(sealedAnswers.iv, "base64"),
  );
  const answers = v.safeParse(
    v.pipe(v.string(), v.parseJson(), desktopRunnerQuestionAnswersSchema),
    plaintext,
  );
  return answers.success
    ? {
        ...message,
        answers: answers.output satisfies DesktopRunnerQuestionAnswers,
      }
    : null;
};
