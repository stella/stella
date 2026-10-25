import { describe, expect, test } from "bun:test";
import path from "node:path";

import { FAILURE_TAGS } from "../apps/api/src/lib/observability/failure-tags.gen";
import { collectFailureTags, failureTagsInSource } from "./failure-tags";

describe("failure tag census", () => {
  test("follows imported factory aliases without executing error modules", () => {
    expect(
      failureTagsInSource(
        `
      import { TaggedError as Failure } from "better-result";
      import * as Result from "better-result";
      class Example extends Failure("Example")<{ message: string }> {}
      class Namespaced extends Result.TaggedError("Namespaced")<{ message: string }> {}
      const unrelated = Other("NotAnErrorTag");
    `,
        "example.ts",
      ),
    ).toEqual(["Example", "Namespaced"]);
  });

  test("requires literal tags so declarations cannot evade the grading census", () => {
    expect(() =>
      failureTagsInSource(
        `
      import { TaggedError } from "better-result";
      class Example extends TaggedError(tag)<{ message: string }> {}
    `,
        "example.ts",
      ),
    ).toThrow("Nonliteral TaggedError tag");
  });

  test("every production TaggedError declaration has a generated policy key", async () => {
    expect(
      await collectFailureTags(path.join(import.meta.dirname, "..")),
    ).toEqual([...FAILURE_TAGS]);
  });
});
