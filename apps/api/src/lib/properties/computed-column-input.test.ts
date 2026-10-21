import { describe, expect, test } from "bun:test";

import type { PropertyContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";

import {
  AIColumnInputRequiredError,
  requireComputedColumnInputs,
} from "./computed-column-input";
import { computedColumnInputHandlerError } from "./computed-column-input-handler-error";

const file = (id: string) => ({
  id: toSafeId<"property">(id),
  content: { version: 1, type: "file" } satisfies PropertyContent,
});

describe("computed column input ownership", () => {
  test("wires the sole document file column when no input was supplied", () => {
    const result = requireComputedColumnInputs({
      candidates: [file("file")],
      inputs: [],
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value).toEqual([
      { dependsOnPropertyId: toSafeId<"property">("file"), condition: null },
    ]);
  });

  test("refuses ambiguous implicit input and names every candidate", () => {
    const result = requireComputedColumnInputs({
      candidates: [file("one"), file("two")],
      inputs: [],
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }
    expect(result.error).toBeInstanceOf(AIColumnInputRequiredError);
    expect(result.error).toMatchObject({
      code: "ai-column-input-required",
      candidateFileColumnIds: ["one", "two"],
    });
    expect(computedColumnInputHandlerError(result.error)).toMatchObject({
      status: 422,
      hint: "Candidate file columns: one, two",
    });
  });
});
