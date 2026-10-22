import { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import { getAnalytics } from "@/lib/analytics/provider";
import {
  loadAuthContext,
  loadAuthContextForRootRedirect,
  requireProfessionalUseForSignedInRoute,
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

describe("professional-use route boundary", () => {
  test("a required account on a public case page returns there after acceptance", async () => {
    const queryClient = new QueryClient();
    const query = spyOn(queryClient, "query")
      .mockResolvedValueOnce({
        session: { userId: "public-reader" },
        user: { id: "public-reader" },
      })
      .mockResolvedValueOnce({ status: "required" })
      .mockResolvedValueOnce({
        session: { userId: "public-reader" },
        user: { id: "public-reader" },
      })
      .mockResolvedValueOnce({
        status: "accepted",
        statementVersion: "2026-10",
        termsVersion: "2026-10",
        acceptedAt: "2026-10-22T00:00:00.000Z",
      });
    const location = {
      pathname: "/law/us/cases/supreme-court/example",
      searchStr: "?q=contract",
    };
    try {
      const required = await Result.tryPromise({
        try: async () =>
          await requireProfessionalUseForSignedInRoute({
            queryClient,
            location,
          }),
        catch: (error) => error,
      });
      expect(required.isErr()).toBe(true);
      const thrown = required.isErr() ? required.error : undefined;
      expect(isRedirect(thrown)).toBe(true);
      expect(thrown).toMatchObject({
        options: {
          to: "/auth/professional-use",
          search: {
            redirectTo: "/law/us/cases/supreme-court/example?q=contract",
          },
        },
      });

      queryClient.removeQueries({ queryKey: ["professional-use"] });
      expect(
        await requireProfessionalUseForSignedInRoute({ queryClient, location }),
      ).toMatchObject({ session: { userId: "public-reader" } });
    } finally {
      query.mockRestore();
      queryClient.clear();
    }
  });

  test("the generated route tree is guarded at its common root", async () => {
    const [rootRoute, routeTree] = await Promise.all([
      Bun.file(new URL("__root.tsx", import.meta.url)).text(),
      Bun.file(new URL("../routeTree.gen.ts", import.meta.url)).text(),
    ]);
    expect(routeTree).toContain("const rootRouteChildren");
    expect(rootRoute).toContain(
      "await requireProfessionalUseForSignedInRoute({",
    );
  });
});
