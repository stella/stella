import { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import { getAnalytics } from "@/lib/analytics/provider";
import {
  loadAuthContext,
  loadAuthContextForRootRedirect,
} from "@/routes/-auth-context";

describe("auth context query outcomes", () => {
  test("propagates the original query rejection after capturing it once", async () => {
    const queryClient = new QueryClient();
    const failure = new Error("Session query unavailable");
    const query = spyOn(queryClient, "query").mockRejectedValue(failure);
    const captureError = spyOn(
      getAnalytics(),
      "captureError",
    ).mockImplementation(() => {});

    try {
      const result = await Result.tryPromise({
        try: async () => await loadAuthContext(queryClient),
        catch: (error) => error,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBe(failure);
      }
      expect(query).toHaveBeenCalledTimes(1);
      expect(captureError).toHaveBeenCalledTimes(1);
      expect(captureError).toHaveBeenCalledWith(failure);
    } finally {
      query.mockRestore();
      captureError.mockRestore();
      queryClient.clear();
    }
  });

  test("keeps the signed-out fallback local to the root redirect", async () => {
    const queryClient = new QueryClient();
    const failure = new Error("Session query unavailable");
    const query = spyOn(queryClient, "query").mockRejectedValue(failure);
    const captureError = spyOn(
      getAnalytics(),
      "captureError",
    ).mockImplementation(() => {});

    try {
      expect(await loadAuthContextForRootRedirect(queryClient)).toEqual({
        session: null,
        user: null,
      });
      expect(query).toHaveBeenCalledTimes(1);
      expect(captureError).toHaveBeenCalledTimes(1);
      expect(captureError).toHaveBeenCalledWith(failure);
    } finally {
      query.mockRestore();
      captureError.mockRestore();
      queryClient.clear();
    }
  });

  test.each([loadAuthContext, loadAuthContextForRootRedirect])(
    "%p treats a successful no-session response as signed out",
    async (loadContext) => {
      const queryClient = new QueryClient();
      const query = spyOn(queryClient, "query").mockResolvedValue(null);
      const captureError = spyOn(
        getAnalytics(),
        "captureError",
      ).mockImplementation(() => {});

      try {
        expect(await loadContext(queryClient)).toEqual({
          session: null,
          user: null,
        });
        expect(query).toHaveBeenCalledTimes(1);
        expect(captureError).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
        captureError.mockRestore();
        queryClient.clear();
      }
    },
  );
});
