import { describe, expect, test } from "bun:test";

import { APIError } from "@/lib/errors/api";
import { PublicLawUnavailableError } from "@/lib/public-law-api";
import { createAppQueryClient } from "@/lib/react-query";

const busy = () => new APIError({ status: 429, message: "Too many requests" });

describe("app query client", () => {
  test("a route load that meets one transient refusal recovers", async () => {
    const queryClient = createAppQueryClient();
    let calls = 0;
    const result = await queryClient.query({
      queryKey: ["transient-refusal"],
      queryFn: async () => {
        calls += 1;
        if (calls === 1) {
          throw busy();
        }
        return "answered";
      },
      // The default policy decides whether to retry; only the wait is shortened.
      retryDelay: 0,
    });
    expect(result).toBe("answered");
    expect(calls).toBe(2);
  });

  test("a final answer fails the load at once", async () => {
    const queryClient = createAppQueryClient();
    let calls = 0;
    const load = queryClient.query({
      queryKey: ["final-answer"],
      queryFn: async () => {
        calls += 1;
        throw new APIError({ status: 404, message: "Not found" });
      },
      retryDelay: 0,
    });
    expect(
      await load.then(
        () => null,
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(APIError);
    expect(calls).toBe(1);
  });

  test("a write is never replayed", async () => {
    const queryClient = createAppQueryClient();
    let calls = 0;
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        calls += 1;
        throw busy();
      },
    });
    expect(
      await mutation.execute(undefined).then(
        () => null,
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(APIError);
    expect(calls).toBe(1);
  });
  test("a disabled public-law read fails the load at once", async () => {
    const queryClient = createAppQueryClient();
    let calls = 0;
    const load = queryClient.query({
      queryKey: ["public-law-disabled"],
      queryFn: async () => {
        calls += 1;
        throw new PublicLawUnavailableError({
          action: "read",
          area: "public-law",
          message: "Public law is not available.",
        });
      },
      retryDelay: 0,
    });
    expect(
      await load.then(
        () => null,
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(PublicLawUnavailableError);
    expect(calls).toBe(1);
  });

  test("a dropped connection is retried", async () => {
    const queryClient = createAppQueryClient();
    let calls = 0;
    const result = await queryClient.query({
      queryKey: ["dropped-connection"],
      queryFn: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError("Failed to fetch");
        }
        return "answered";
      },
      retryDelay: 0,
    });
    expect(result).toBe("answered");
    expect(calls).toBe(2);
  });
});
