import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
  isActionAdmissionCode,
  type ActionAdmissionRefusal,
} from "@stll/api-contract/action-admission";

import {
  actionAdmissionRefusalLines,
  readActionAdmissionRefusal,
} from "../../../../packages/cli/src/action-admission-refusal.ts";
import { ACTION_ADMISSION_REFUSALS as CLI_ADMISSION_REFUSALS } from "../../../../packages/cli/src/generated/mcp-contract.ts";
import { serializeToolResult, structuredErrorResult } from "./tool-utils";

test("every MCP refusal retains identical structured fields and renders through the CLI and HTTP parser", () => {
  expect(CLI_ADMISSION_REFUSALS).toEqual(ACTION_ADMISSION_REFUSALS);
  const observedCodes: string[] = [];
  for (const [code, metadata] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
    if (!isActionAdmissionCode(code)) {
      panic("Admission metadata has an unknown code");
    }
    const contactUrl =
      code === ACTION_ADMISSION_CODES.periodExhausted ||
      code === ACTION_ADMISSION_CODES.notEnabled
        ? "https://example.test/contact"
        : undefined;
    const fixture = {
      code,
      message: metadata.message,
      hint:
        contactUrl === undefined
          ? metadata.hint
          : `${metadata.hint} Contact: ${contactUrl}`,
      retryable: metadata.retryable,
      ...(contactUrl === undefined ? {} : { contactUrl }),
    } satisfies ActionAdmissionRefusal;
    const mcp = serializeToolResult(structuredErrorResult(fixture));
    const text = mcp.content.at(0);
    if (text?.type !== "text") {
      panic("MCP refusal has no text envelope");
    }
    const payload: unknown = JSON.parse(text.text);
    const fromMcp = readActionAdmissionRefusal(payload);
    const fromHttp = readActionAdmissionRefusal(fixture);
    expect(mcp.isError).toBe(true);
    expect(fromMcp).toEqual(fixture);
    expect(fromHttp).toEqual(fixture);
    if (fromMcp === undefined || fromHttp === undefined) {
      panic("CLI lost an admission refusal");
    }
    expect(actionAdmissionRefusalLines(fromMcp)).toEqual(
      actionAdmissionRefusalLines(fromHttp),
    );
    expect(actionAdmissionRefusalLines(fromMcp)).toContain(`code: ${code}`);
    expect(actionAdmissionRefusalLines(fromMcp)).toContain(
      `retryable: ${metadata.retryable}`,
    );
    if (contactUrl !== undefined) {
      expect(actionAdmissionRefusalLines(fromMcp)).toContain(
        `contact: ${contactUrl}`,
      );
    }
    observedCodes.push(code);
  }
  expect(observedCodes.toSorted()).toEqual(
    Object.keys(ACTION_ADMISSION_REFUSALS).toSorted(),
  );
});
