import { Result } from "better-result";
import * as v from "valibot";

import { env } from "@/api/env";
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
const previousCredentialSchema = v.pipe(
  v.string(),
  v.regex(/^[a-f0-9]{64}$/u),
  v.brand("PreviousAgentClientCredential"),
);
export type StoredAgentClientCredential =
  | EncryptedAgentClientCredential
  | v.InferOutput<typeof previousCredentialSchema>;

const CREDENTIAL_PREFIX = "stella-agent:v1:";
const LEGACY_CREDENTIAL_PATTERN = /^[a-f0-9]{64}$/u;
const CREDENTIAL_ENVELOPE_PATTERN =
  /^([A-Za-z0-9+/]{16}):([A-Za-z0-9+/]+={0,2})$/u;

export const encryptAgentClientCredential = async (
  credential: string,
): Promise<Result<EncryptedAgentClientCredential, HandlerError>> => {
  const content = await encryptAppContent(credential);
  if (Result.isError(content))
    {return Result.err(
      new HandlerError({
        status: 503,
        message: "Could not secure agent credentials",
      }),
    );}
  const { ciphertext, iv } = content.value;
  return Result.ok(
    v.parse(
      encryptedCredentialSchema,
      `${CREDENTIAL_PREFIX}${iv.toString("base64")}:${ciphertext.toString("base64")}`,
    ),
  );
};

export const prepareAgentClientCredential = async (
  credential: string,
): Promise<Result<StoredAgentClientCredential, HandlerError>> => {
  if (env.AGENT_CLIENT_STORAGE_V1_ENABLED)
    {return await encryptAgentClientCredential(credential);}
  const parsed = v.safeParse(previousCredentialSchema, credential);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new HandlerError({
          status: 500,
          message: "Agent credential is invalid",
        }),
      );
};

type ReadAgentClientCredentialOptions = {
  storedCredential: string;
  upgrade: (
    encrypted: EncryptedAgentClientCredential,
  ) => Promise<Result<void, HandlerError>>;
};

export const readAgentClientCredential = async ({
  storedCredential,
  upgrade,
}: ReadAgentClientCredentialOptions): Promise<Result<string, HandlerError>> => {
  if (LEGACY_CREDENTIAL_PATTERN.test(storedCredential)) {
    logger.info("agent.credentials.legacy_read", { "migration.read_count": 1 });
    if (env.AGENT_CLIENT_STORAGE_V1_ENABLED) {
      const envelope = await encryptAgentClientCredential(storedCredential);
      if (Result.isError(envelope)) {return Result.err(envelope.error);}
      const updated = await upgrade(envelope.value);
      if (Result.isError(updated)) {return Result.err(updated.error);}
    }
    return Result.ok(storedCredential);
  }

  const match = storedCredential.startsWith(CREDENTIAL_PREFIX)
    ? CREDENTIAL_ENVELOPE_PATTERN.exec(
        storedCredential.slice(CREDENTIAL_PREFIX.length),
      )
    : null;
  const encodedIv = match?.at(1);
  const encodedCiphertext = match?.at(2);
  if (!encodedIv || !encodedCiphertext) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Stored agent credential is invalid",
      }),
    );
  }
  const iv = Buffer.from(encodedIv, "base64");
  const ciphertext = Buffer.from(encodedCiphertext, "base64");
  if (
    ciphertext.length < 16 ||
    ciphertext.toString("base64") !== encodedCiphertext
  ) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Stored agent credential is invalid",
      }),
    );
  }
  const content = await decryptAppContent(ciphertext, iv);
  return Result.isError(content)
    ? Result.err(
        new HandlerError({
          status: 500,
          message: "Could not read stored agent credential",
        }),
      )
    : Result.ok(content.value);
};
