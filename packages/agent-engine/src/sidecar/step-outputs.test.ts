import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES } from "@stll/api-contract/chat-local-run-step-output";
import { assertProperty } from "@stll/property-testing";

import { stepOutputFile } from "./step-outputs";

const read = (file: Uint8Array) => {
  const newline = file.indexOf(0x0a);
  const header: unknown = JSON.parse(
    new TextDecoder().decode(file.subarray(0, newline)),
  );
  return { header, kept: file.subarray(newline + 1) };
};

describe("a kept step output", () => {
  test("names how much the step produced and keeps a whole-character prefix within the cap", () => {
    assertProperty(
      "names how much the step produced and keeps a whole-character prefix within the cap",
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 40 }),
        fc.integer({ min: 0, max: 3 }),
        (unit, padding) => {
          // Long enough to cross the cap at any offset of a multi-byte unit.
          const text = `${"x".repeat(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES - padding)}${unit.repeat(4)}`;
          const bytes = new TextEncoder().encode(text);
          const { header, kept } = read(stepOutputFile(text));
          expect(header).toEqual({ bytes: bytes.length });
          expect(kept.length).toBeLessThanOrEqual(
            CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
          );
          expect(bytes.subarray(0, kept.length)).toEqual(kept);
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            kept,
          );
          expect(text.startsWith(decoded)).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  test("keeps a short output whole", () => {
    const { header, kept } = read(stepOutputFile("ok\n"));
    expect(header).toEqual({ bytes: 3 });
    expect(new TextDecoder().decode(kept)).toBe("ok\n");
  });
});
