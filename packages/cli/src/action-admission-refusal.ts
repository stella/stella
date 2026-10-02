import { Result } from "better-result";

import {
  ACTION_ADMISSION_REFUSALS,
  type ActionAdmissionCode,
} from "./generated/mcp-contract.js";
import type { OutputFormat } from "./output.js";

const isActionAdmissionCode = (code: unknown): code is ActionAdmissionCode =>
  typeof code === "string" && Object.hasOwn(ACTION_ADMISSION_REFUSALS, code);

export type CliActionAdmissionRefusal = {
  code: ActionAdmissionCode;
  message: string;
  hint: string;
  retryable: boolean;
  contactUrl?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Both HTTP bodies and MCP envelopes carry the same admission contract. */
export const readCliActionAdmissionRefusal = (
  payload: unknown,
): CliActionAdmissionRefusal | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }
  const body = isRecord(payload["error"]) ? payload["error"] : payload;
  if (
    !isActionAdmissionCode(body["code"]) ||
    typeof body["message"] !== "string"
  ) {
    return undefined;
  }
  const code = body["code"];
  const metadata = ACTION_ADMISSION_REFUSALS[code];
  return {
    code,
    message: body["message"],
    hint: typeof body["hint"] === "string" ? body["hint"] : metadata.hint,
    retryable:
      typeof body["retryable"] === "boolean"
        ? body["retryable"]
        : metadata.retryable,
    ...(typeof body["contactUrl"] === "string"
      ? { contactUrl: body["contactUrl"] }
      : {}),
  };
};

export const readHttpActionAdmissionRefusal = async (
  response: Response,
): Promise<CliActionAdmissionRefusal | undefined> => {
  const body = await Result.tryPromise(
    async (): Promise<unknown> => await response.clone().json(),
  );
  return Result.isOk(body)
    ? readCliActionAdmissionRefusal(body.value)
    : undefined;
};

export const actionAdmissionRefusalLines = (
  refusal: CliActionAdmissionRefusal,
): string[] => [
  `error: ${refusal.message}`,
  `code: ${refusal.code}`,
  `retryable: ${refusal.retryable}`,
  `hint: ${refusal.hint}`,
  ...(refusal.contactUrl === undefined
    ? []
    : [`contact: ${refusal.contactUrl}`]),
];

export const actionAdmissionRefusalOutput = ({
  refusal,
  format,
  requestId,
}: {
  refusal: CliActionAdmissionRefusal;
  format?: OutputFormat | undefined;
  requestId?: string;
}): string =>
  format === "json" || format === "jsonl"
    ? `${JSON.stringify({ error: { ...refusal, ...(requestId === undefined ? {} : { requestId }) } })}\n`
    : `${actionAdmissionRefusalLines(refusal).join("\n")}\n`;
