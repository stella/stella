import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { AI_CONFIG_UNREADABLE_ERROR_CODE } from "@/api/lib/ai-config-response";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import readAIConfig from "./read-ai-config";
import updateAIConfig from "./update-ai-config";

/**
 * A stored row that cannot be decrypted with the org's current key: a
 * non-zero IV (so the row is not the plaintext envelope) over bytes that fail
 * the AES-GCM tag. `decryptAIConfig` rejects on it exactly as it would in
 * production after a key rotation, so neither handler needs a module mock to
 * reach its decrypt-failure branch.
 */
const undecryptableRow = {
  aiConfigEncrypted: Buffer.from(
    "9f3c1a77e5b40d28cc6f01935ae2d4b8a71c5e6039f8d24b7ce013a5b6082f4d",
    "hex",
  ),
  aiConfigIv: Buffer.from("a1b2c3d4e5f60718293a4b5c", "hex"),
};

type UpdateContext = Parameters<typeof updateAIConfig.handler>[0];
type ReadContext = Parameters<typeof readAIConfig.handler>[0];

const updateBody = {
  providers: [{ provider: "google", apiKey: "test-google-key" }],
  overrideModels: {
    fast: { provider: "google", modelId: "gemini-3.5-flash" },
    chat: { provider: "google", modelId: "gemini-3.5-flash" },
    reasoning: { provider: "google", modelId: "gemini-3.1-pro-preview" },
    pdf: { provider: "google", modelId: "gemini-3.5-flash" },
  },
};

const writeRejectingTx = asTestRaw<Transaction>({
  insert: () => {
    throw new Error("the stored AI config must not be overwritten");
  },
});

/**
 * Serves the settings row on the first operation. Both handlers read the row
 * first, so any later operation is the write path a decrypt failure has to
 * prevent; it runs against a transaction that refuses inserts.
 */
const createSettingsDb = (): {
  safeDb: SafeDb;
  operationCount: () => number;
} => {
  let operationCount = 0;
  const safeDb: SafeDb = async <T>(
    operation: (tx: Transaction) => Promise<T>,
  ) => {
    operationCount += 1;
    return operationCount === 1
      ? Result.ok(asTestRaw<T>(undecryptableRow))
      : Result.ok(await operation(writeRejectingTx));
  };
  return { safeDb, operationCount: () => operationCount };
};

describe("AI config handlers with an undecryptable stored config", () => {
  test("update fails closed instead of merging onto an empty config", async () => {
    const { safeDb, operationCount } = createSettingsDb();

    const result = await updateAIConfig.handler(
      createTestHandlerContext<UpdateContext>({ body: updateBody, safeDb }),
    );

    if (!("code" in result)) {
      throw new Error("Expected the decrypt failure to return a status");
    }
    expect(result.code).toBe(503);
    expect(result.response).toMatchObject({
      code: AI_CONFIG_UNREADABLE_ERROR_CODE,
    });
    // Only the settings read ran: the merge, the provider probe, and the
    // write never start, so the request cannot narrow the stored providers
    // down to the ones its body happens to carry.
    expect(operationCount()).toBe(1);
  });

  test("read reports the failure instead of an unconfigured org", async () => {
    const { safeDb } = createSettingsDb();

    const result = await readAIConfig.handler(
      createTestHandlerContext<ReadContext>({ safeDb }),
    );

    if (!("code" in result)) {
      throw new Error("Expected the decrypt failure to return a status");
    }
    expect(result.code).toBe(503);
    expect(result.response).toMatchObject({
      code: AI_CONFIG_UNREADABLE_ERROR_CODE,
    });
  });
});
