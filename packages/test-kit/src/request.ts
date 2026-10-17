import { requestHandler } from "@tanstack/react-start/server";
import { Result } from "better-result";
import { expect } from "bun:test";

// The framework converts thrown errors into HTTP responses. Retain the original
// rejection outside that boundary, including non-Error values and undefined.
export const runInRequest = async (
  scenario: () => unknown,
  request = new Request("http://localhost:3000/"),
): Promise<void> => {
  let outcome: Result<void, unknown> | undefined;
  const handle = requestHandler(async () => {
    outcome = await Result.tryPromise({
      try: async () => {
        await scenario();
      },
      catch: (error) => error,
    });
    return new Response(null);
  });
  const response = await handle(request, {});
  if (outcome?.isErr()) {
    throw outcome.error;
  }
  expect(response.status).toBe(200);
  expect(outcome?.isOk()).toBe(true);
};
