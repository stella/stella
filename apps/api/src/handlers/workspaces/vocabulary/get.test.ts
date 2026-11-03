import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { readVocabularyHandler } from "./get";

test("propagates a failed vocabulary transaction instead of reporting empty candidates", async () => {
  const failure = new HandlerError({
    status: 500,
    message: "Vocabulary read unavailable",
  });
  expect(
    await rejectionOf(
      readVocabularyHandler({
        organizationId: mintAuthProviderId<"organization">(),
        workspaceId: createSafeId<"workspace">(),
        scopedDb: async () => {
          throw failure;
        },
      }),
    ),
  ).toBe(failure);
});
