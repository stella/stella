import { Result } from "better-result";
import * as v from "valibot";

import { captureError } from "@/api/lib/analytics/capture";
import {
  decryptAppContent,
  encryptAppContent,
} from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";

const encryptedCredentialSchema = v.pipe(
  v.string(),
  v.brand("EncryptedAgentClientCredential"),
);
export type EncryptedAgentClientCredential = v.InferOutput<
  typeof encryptedCredentialSchema
>;

const CREDENTIAL_PREFIX = "stella-agent:v1:";
const LEGACY_CREDENTIAL_PATTERN = /^[a-f0-9]{64}$/u;
const CREDENTIAL_ENVELOPE_PATTERN =
  /^([A-Za-z0-9+/]{16}):([A-Za-z0-9+/]+={0,2})$/u;

export const encryptAgentClientCredential = async (
  credential: string,
): Promise<EncryptedAgentClientCredential> => {
  const result = await Result.tryPromise({
    try: async () => {
      const { ciphertext, iv } = await encryptAppContent(credential);
      return v.parse(
        encryptedCredentialSchema,
        `${CREDENTIAL_PREFIX}${iv.toString("base64")}:${ciphertext.toString("base64")}`,
      );
    },
    catch: () =>
      new HandlerError({
        status: 503,
        message: "Could not secure agent credentials",
      }),
  });
  if (Result.isError(result)) {
    captureError(result.error);
    throw result.error;
  }
  return result.value;
};

type ReadAgentClientCredentialOptions = {
  storedCredential: string;
  upgrade: (encrypted: EncryptedAgentClientCredential) => Promise<void>;
};

export const readAgentClientCredential = async ({
  storedCredential,
  upgrade,
}: ReadAgentClientCredentialOptions): Promise<string> => {
  if (LEGACY_CREDENTIAL_PATTERN.test(storedCredential)) {
    logger.info("agent.credentials.legacy_read", { "migration.read_count": 1 });
    await upgrade(await encryptAgentClientCredential(storedCredential));
    return storedCredential;
  }

  const match = storedCredential.startsWith(CREDENTIAL_PREFIX)
    ? CREDENTIAL_ENVELOPE_PATTERN.exec(
        storedCredential.slice(CREDENTIAL_PREFIX.length),
      )
    : null;
  const encodedIv = match?.at(1);
  const encodedCiphertext = match?.at(2);
  if (!encodedIv || !encodedCiphertext) {
    throw new HandlerError({
      status: 500,
      message: "Stored agent credential is invalid",
    });
  }
  const iv = Buffer.from(encodedIv, "base64");
  const ciphertext = Buffer.from(encodedCiphertext, "base64");
  if (
    ciphertext.length < 16 ||
    ciphertext.toString("base64") !== encodedCiphertext
  ) {
    throw new HandlerError({
      status: 500,
      message: "Stored agent credential is invalid",
    });
  }
  const result = await Result.tryPromise({
    try: async () => await decryptAppContent(ciphertext, iv),
    catch: () =>
      new HandlerError({
        status: 500,
        message: "Could not read stored agent credential",
      }),
  });
  if (Result.isError(result)) {
    captureError(result.error);
    throw result.error;
  }
  return result.value;
};
