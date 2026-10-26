import { panic } from "better-result";
import * as v from "valibot";

import {
  contentEncryptionKeyInvariantViolation,
  contentEncryptionKeySchema,
} from "@/api/env-document-processing-worker-schema";
import { resolveConfigurationPlaceholders } from "@/api/lib/configuration-placeholders";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";
import { isLocalTestRun, runtimeMode } from "@/api/runtime-mode";

type MasterKeyState = { hex: string | undefined; key: Buffer | null };
let masterKeyState: MasterKeyState | undefined;

/** Simulate unavailable credential storage only inside a local test run. */
export const withoutContentEncryptionKeyForTesting = (): (() => void) => {
  if (!isLocalTestRun()) {
    return panic("Content encryption key fixtures require a local test run");
  }
  const previous = masterKeyState;
  masterKeyState = { hex: undefined, key: null };
  return () => {
    masterKeyState = previous;
  };
};

/** Encryption reads only its own key; migration repair does not need worker S3/Redis settings. */
export const getContentEncryptionMasterKey = (): Buffer | null => {
  if (masterKeyState === undefined) {
    const resolved = resolveConfigurationPlaceholders({
      schema: { CONTENT_ENCRYPTION_KEY: contentEncryptionKeySchema },
      values: process.env,
    });
    if (resolved.violation !== null) {
      throw new ConfigurationError({ message: resolved.violation });
    }
    const parsed = v.safeParse(
      contentEncryptionKeySchema,
      resolved.runtimeEnv["CONTENT_ENCRYPTION_KEY"],
    );
    if (!parsed.success) {
      throw new ConfigurationError({
        message: "CONTENT_ENCRYPTION_KEY must be a 64-character hex string",
      });
    }
    const hex = parsed.output;
    masterKeyState = { hex, key: hex ? Buffer.from(hex, "hex") : null };
  }
  const violation = contentEncryptionKeyInvariantViolation({
    contentEncryptionKey: masterKeyState.hex,
    runtimeMode: runtimeMode(),
  });
  if (violation !== null) {
    throw new ConfigurationError({ message: violation });
  }
  return masterKeyState.key;
};
