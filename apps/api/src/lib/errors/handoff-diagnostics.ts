import { sanitizeErrorForOutput } from "@stll/errors";

export const sanitizeHandoffDiagnosticText = (text: string): string =>
  text.replace(/sh1_[A-Za-z0-9_-]{43}/gu, "[redacted]");

/** Redact browser credentials from the fresh, bounded query-error projection. */
export const sanitizeDiagnosticErrorForOutput = (value: unknown): unknown => {
  const redact = (output: unknown): unknown => {
    if (typeof output === "string") {
      return sanitizeHandoffDiagnosticText(output);
    }
    if (output === null || typeof output !== "object") {
      return output;
    }
    for (const key of Reflect.ownKeys(output)) {
      const descriptor = Object.getOwnPropertyDescriptor(output, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        continue;
      }
      const safeKey =
        typeof key === "string"
          ? sanitizeHandoffDiagnosticText(key)
          : Symbol(sanitizeHandoffDiagnosticText(key.description ?? ""));
      Object.defineProperty(output, safeKey, {
        ...descriptor,
        value: redact(descriptor.value),
      });
      if (safeKey !== key) {
        Reflect.deleteProperty(output, key);
      }
    }
    return output;
  };
  return redact(sanitizeErrorForOutput(value));
};
