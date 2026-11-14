import { panic, Result } from "better-result";
import * as v from "valibot";

import { chatLocalRunOutputKeySchema } from "@stll/api-contract/chat-local-run-step-output";

import type { SafeId } from "@/api/lib/branded-types";
import {
  decryptContent,
  encryptContent,
  type EncryptedContent,
} from "@/api/lib/content-encryption";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";

/**
 * Each run has its own output key: random, minted when the run is assigned,
 * stored with the run encrypted for its organization, and sent to the
 * computer in `run.start`, which keeps it beside the run's outputs. Every
 * grant to read the run's step outputs there is signed with it
 * (`step-output-grants.ts`). Nothing about it derives from the deployment's
 * other secrets, so rotating them leaves every run's grants valid. It is
 * opened only to compose `run.start` and to sign a grant, and never logged.
 */

/** 32 random bytes: as strong as the HMAC-SHA256 grants signed with it. */
const OUTPUT_KEY_BYTES = 32;

/** A new run's output key, as 64 lowercase hex characters. */
export const mintRunOutputKey = (): string =>
  Buffer.from(
    crypto.getRandomValues(new Uint8Array(OUTPUT_KEY_BYTES)),
  ).toString("hex");

/** A run's output key as the run stores it. */
export type SealedRunOutputKey = EncryptedContent;

export const sealRunOutputKey = async (
  organizationId: SafeId<"organization">,
  outputKey: string,
): Promise<SealedRunOutputKey> =>
  await encryptContent(organizationId, outputKey);

export type OpenedRunOutputKey =
  { type: "opened"; outputKey: string } | { type: "unreadable" };

/**
 * A stored output key, opened. It is `unreadable` when the run keeps none
 * (assigned before runs kept one), the organization's key does not open it,
 * or it opens to something other than a key. Without a content key at all
 * nothing opens yet, so that panics, as it does for queued answers.
 */
export const openRunOutputKey = async (
  organizationId: SafeId<"organization">,
  sealed: SealedRunOutputKey | null,
): Promise<OpenedRunOutputKey> => {
  if (sealed === null) {
    return { type: "unreadable" };
  }
  const decrypted = await Result.tryPromise({
    try: async () =>
      await decryptContent(organizationId, sealed.ciphertext, sealed.iv),
    catch: (cause) => cause,
  });
  if (decrypted.isErr()) {
    if (decrypted.error instanceof ConfigurationError) {
      return panic(
        "A run's output key cannot open: no content key",
        decrypted.error,
      );
    }
    return { type: "unreadable" };
  }
  const outputKey = v.safeParse(chatLocalRunOutputKeySchema, decrypted.value);
  return outputKey.success
    ? { type: "opened", outputKey: outputKey.output }
    : { type: "unreadable" };
};

/** The stored pair of columns as a sealed key; `null` unless both are set. */
export const storedRunOutputKey = (
  ciphertext: Buffer | null,
  iv: Buffer | null,
): SealedRunOutputKey | null =>
  ciphertext === null || iv === null ? null : { ciphertext, iv };
