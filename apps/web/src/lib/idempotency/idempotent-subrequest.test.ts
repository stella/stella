import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { deriveIdempotentRequest } from "./idempotent-subrequest";

test("suboperation keys are stable, distinct and bounded across scope names", async () => {
  await assertProperty(
    "suboperation keys are stable, distinct and bounded across scope names",
    fc.asyncProperty(
      fc.string(),
      fc
        .tuple(fc.string(), fc.string())
        .filter(([first, second]) => first !== second),
      async (key, [first, second]) => {
        const request = { headers: { "Idempotency-Key": key } };
        const firstRequest = await deriveIdempotentRequest(request, first);
        expect(await deriveIdempotentRequest(request, first)).toEqual(
          firstRequest,
        );
        expect(await deriveIdempotentRequest(request, second)).not.toEqual(
          firstRequest,
        );
        expect(firstRequest.headers["Idempotency-Key"]).toHaveLength(64);
        expect(firstRequest.headers["Idempotency-Key"]).toMatch(/^[0-9a-f]+$/u);
      },
    ),
  );
});
