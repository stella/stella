import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { ProviderCallError } from "@/api/lib/errors/provider-call-error";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";

import { ChatCompactionError } from "./thread-compaction";

const sink = failureSink({ event: "chat.compaction_test", expected: [] });
const model = { provider: "openai", keySource: "instance" } as const;
const threadId = createSafeId<"chatThread">();

const reasonFor = (cause: unknown) =>
  gradeFailure(
    readEvidence(
      new ChatCompactionError({
        message: "compaction failed",
        cause,
        threadId,
      }),
    ),
    sink,
  ).reason;

test("a provider call cause keeps the provider's grade", () => {
  expect(
    reasonFor(
      new ProviderCallError({
        model,
        status: 503,
        kind: "provider_unavailable",
      }),
    ),
  ).toBe("provider_unavailable");
});

test("any other cause stays a tagged failure", () => {
  expect(reasonFor(new Error("unexpected"))).toBe("tagged_failure");
  expect(reasonFor(undefined)).toBe("tagged_failure");
});
