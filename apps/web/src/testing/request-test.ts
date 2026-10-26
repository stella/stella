import { createServerEntry } from "@tanstack/react-start/server";
import { Result } from "better-result";
import { expect, test } from "bun:test";

// The framework converts thrown errors into HTTP responses. Keep the original
// rejection outside that boundary, including non-Error values and undefined.
export const runInRequest = async (
  scenario: () => unknown,
  request = new Request("http://localhost:3000/"),
): Promise<void> => {
  let outcome: Result<void, unknown> | undefined;
  const entry = createServerEntry({
    fetch: async () => {
      outcome = await Result.tryPromise({
        try: async () => {
          await scenario();
        },
        catch: (error) => error,
      });
      return new Response(null);
    },
  });
  const response = await entry.fetch(request, {});
  if (outcome?.isErr()) {
    throw outcome.error;
  }
  expect(response.status).toBe(200);
  expect(outcome?.isOk()).toBe(true);
};

// Bun executes server branches of the web modules. Scope each browser-model
// scenario to a real request so API headers never read missing framework state.
export const requestTest = (name: string, scenario: () => unknown) =>
  test(name, async () => await runInRequest(scenario));
