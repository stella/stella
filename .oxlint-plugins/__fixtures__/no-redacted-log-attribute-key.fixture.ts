// Passive regression fixture for
// `no-redacted-log-attribute-key/no-redacted-log-attribute-key`.

import { logger } from "@/api/lib/observability/logger";

const queueName = "document-review-run";
const attempt = 2;

export const redactedKeys = (): void => {
  // MUST flag: `queueName` matches `name`, so the sanitizer drops it.
  logger.error("worker.failed", {
    // oxlint-disable-next-line no-redacted-log-attribute-key/no-redacted-log-attribute-key -- fixture: shorthand key matching the denylist
    queueName,
  });

  // MUST flag: a string-literal key is checked the same way.
  logger.warn("upload.rejected", {
    // oxlint-disable-next-line no-redacted-log-attribute-key/no-redacted-log-attribute-key -- fixture: literal key matching the denylist
    "file.fileName": "contract.docx",
  });

  // MUST flag: a credential-shaped key is a payload, not a label.
  logger.info("auth.refresh", {
    // oxlint-disable-next-line no-redacted-log-attribute-key/no-redacted-log-attribute-key -- fixture: credential-shaped key
    apiKey: "redacted-anyway",
  });
};

export const acceptedKeys = (): void => {
  // Allowed: the same information under a key the sanitizer keeps.
  logger.error("worker.failed", { queue: queueName, attempt });

  // Allowed: usage metrics survive the `prompt` lookahead.
  logger.info("ai.usage", { promptTokens: 120, prompt_tokens: 120 });

  // Allowed: a computed key has no static name to check here.
  const dynamicKey = "attempt";
  logger.warn("worker.retry", { [dynamicKey]: attempt });
};

// Allowed: an unrelated object with the same method names is not the logger.
const audit = {
  error: (event: string, fields: Record<string, string>): string =>
    `${event}:${Object.keys(fields).length}`,
};
export const auditLine = audit.error("audit.failed", {
  fileName: "not-a-log-record",
});
