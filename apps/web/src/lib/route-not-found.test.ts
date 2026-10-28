import { isNotFound } from "@tanstack/react-router";
import { expect, test } from "bun:test";

import { APIError } from "@/lib/errors/api";
import { loadRouteResource } from "@/lib/route-not-found";

const ID = "0194d94a-1122-7000-8000-123456789abc";

test("malformed route ids become not found without loading", async () => {
  let loaded = false;
  const result = loadRouteResource({
    ids: ["not-an-id"],
    load: async () => {
      loaded = true;
      return {};
    },
  });

  expect(loaded).toBe(false);
  expect(isNotFound(await result.catch((error: unknown) => error))).toBe(true);
});

for (const status of [403, 404]) {
  test(`HTTP ${status} route resources become not found`, async () => {
    const result = loadRouteResource({
      ids: [ID],
      load: async () => {
        throw new APIError({ status, message: "missing" });
      },
    });

    expect(isNotFound(await result.catch((error: unknown) => error))).toBe(
      true,
    );
  });
}

test("a successful response that names no resource becomes not found", async () => {
  const result = loadRouteResource({
    ids: [ID],
    load: async () => ({ exists: false }),
    exists: ({ exists }) => exists,
  });

  expect(isNotFound(await result.catch((error: unknown) => error))).toBe(true);
});

test("other loader failures are preserved", async () => {
  const failure = new APIError({ status: 500, message: "failed" });
  const result = loadRouteResource({
    ids: [ID],
    load: async () => {
      throw failure;
    },
  });

  expect(await result.catch((error: unknown) => error)).toBe(failure);
});
