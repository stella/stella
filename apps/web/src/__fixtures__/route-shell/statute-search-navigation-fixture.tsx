import { expect, test } from "bun:test";
import { panic, TaggedError } from "better-result";

import type { api } from "@/lib/api";
import type { PublicLawData } from "@/lib/public-law-api";
import type { StatuteListItem } from "@/features/statutes/queries/statutes";
import { APIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

import type { FixtureRuntime } from "./route-shell-provider-fixture";

class FixtureRouteLoaderError extends TaggedError("FixtureRouteLoaderError")<{
  message: string;
}> {}

type StatutesResponse = PublicLawData<typeof api.law.statutes.get>;

const statute = {
  amendmentCount: 2,
  citationCaseCount: null,
  country: "CZE",
  documentType: "zákon",
  documentUrl: null,
  effectiveDate: "2026-01-01",
  eli: "/eli/cz/sb/2026/1",
  firstVersionValidFrom: "2026-01-01",
  id: toSafeId<"legislationDocument">(
    "00000000-0000-4000-8000-000000000013",
  ),
  language: "cs",
  lastAmendedOn: "2026-01-01",
  slug: "fixture-act",
  sourceUrl: null,
  status: "current",
  title: "1/2026 Sb., Fixture act",
  validity: "in-force",
  versionValidFrom: "2026-01-01",
  versionValidTo: null,
} satisfies StatuteListItem;

const statutesResponse = {
  items: [statute],
  limit: 25,
  nextCursor: null,
} satisfies StatutesResponse;

export const declareStatuteSearchNavigationCases = (
  fixture: FixtureRuntime,
) => {
  test("a failed statute route retries its unchanged search", async () => {
    const { Route } = await import("@/routes/law/$country/statutes/index");
    const originalLoader = Route.options.loader;
    if (typeof originalLoader !== "function") {
      panic("The statute route must have a loader");
    }
    let loaderCalls = 0;
    let fails = true;
    Route.options.loader = async (context) => {
      loaderCalls += 1;
      if (fails) {
        throw new FixtureRouteLoaderError({
          message: "Fixture route loader failure",
        });
      }
      const data: unknown = await originalLoader(context);
      return data;
    };
    fixture.state.audience = "anonymous";
    fixture.state.response = (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/law/statutes") {
        return Response.json(statutesResponse);
      }
      if (pathname === "/v1/law/statutes/facets") {
        return Response.json({ documentType: [] });
      }
      return undefined;
    };
    const runtime = await mountStatutes(fixture);
    try {
      await fixture.waitFor(() => {
        expect(
          runtime.router.state.matches.find(
            (match) => match.routeId === "/law/$country/statutes/",
          )?.status,
        ).toBe("error");
        expect(button("Retry")).not.toBeNull();
      });
      const failedSearch = runtime.router.state.location.search;
      const failedLoaderCalls = loaderCalls;
      fails = false;
      fixture.act(() => button("Retry")?.click());
      await fixture.waitFor(() => {
        expect(loaderCalls).toBeGreaterThan(failedLoaderCalls);
        expect(runtime.router.state.location.search).toEqual(failedSearch);
        expect(document.body.textContent).toContain("Fixture act");
        expect(
          runtime.router.state.matches.find(
            (match) => match.routeId === "/law/$country/statutes/",
          )?.status,
        ).toBe("success");
      });
    } finally {
      Route.options.loader = originalLoader;
      await unmountStatutes(fixture, runtime);
    }
  });

  test("a failed case-law route retries its unchanged search", async () => {
    const { Route } = await import("@/routes/law/cases/index");
    const originalLoader = Route.options.loader;
    if (typeof originalLoader !== "function") {
      panic("The case-law route must have a loader");
    }
    let loaderCalls = 0;
    let fails = true;
    Route.options.loader = async (context) => {
      loaderCalls += 1;
      if (fails) {
        throw new FixtureRouteLoaderError({
          message: "Fixture route loader failure",
        });
      }
      const data: unknown = await originalLoader(context);
      return data;
    };
    fixture.state.audience = "anonymous";
    const runtime = await mountStatutes(fixture, "/law/cases?country=svk");
    try {
      await fixture.waitFor(() => {
        expect(
          runtime.router.state.matches.find(
            (match) => match.routeId === "/law/cases/",
          )?.status,
        ).toBe("error");
        expect(button("Retry")).not.toBeNull();
      });
      const failedSearch = runtime.router.state.location.search;
      const failedLoaderCalls = loaderCalls;
      fails = false;
      fixture.act(() => button("Retry")?.click());
      await fixture.waitFor(() => {
        expect(loaderCalls).toBeGreaterThan(failedLoaderCalls);
        expect(runtime.router.state.location.search).toEqual(failedSearch);
        expect(
          runtime.router.state.matches.find(
            (match) => match.routeId === "/law/cases/",
          )?.status,
        ).toBe("success");
      });
    } finally {
      Route.options.loader = originalLoader;
      await unmountStatutes(fixture, runtime);
    }
  });

  test("statute list keeps search and filters after a server failure, then retries successfully", async () => {
    let listReads = 0;
    fixture.state.audience = "anonymous";
    fixture.state.response = (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/law/statutes") {
        listReads += 1;
        if (listReads === 1) {
          return Response.json(
            { message: "Corpus unavailable" },
            { status: 503 },
          );
        }
        return Response.json(statutesResponse);
      }
      if (pathname === "/v1/law/statutes/facets") {
        return Response.json({ documentType: [{ value: "zákon", count: 1 }] });
      }
      return undefined;
    };
    const runtime = await mountStatutes(fixture);
    try {
      await fixture.waitFor(() => {
        expect(searchInput().value).toBe("");
        expect(document.body.textContent).toContain(
          "Search is temporarily unavailable",
        );
        expect(button("Filters")).not.toBeNull();
        expect(button("Retry")).not.toBeNull();
      });
      fixture.act(() => {
        button("Retry")?.click();
      });
      await fixture.waitFor(() => {
        expect(document.body.textContent).toContain("Fixture act");
        expect(searchInput()).not.toBeNull();
        expect(button("Filters")).not.toBeNull();
      });
      expect(listReads).toBeGreaterThan(1);
      expect(runtime.caughtErrors.length).toBeGreaterThan(0);
      expect(runtime.caughtErrors.every((error) => APIError.is(error) && error.status === 503)).toBe(true);
    } finally {
      await unmountStatutes(fixture, runtime);
    }
  });

  test("statute list keeps search and filters after a rejected response without offering retry", async () => {
    fixture.state.audience = "anonymous";
    fixture.state.response = (request) => {
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (pathname === "/v1/law/statutes") {
        return Response.json({ message: "Invalid request" }, { status: 400 });
      }
      if (pathname === "/v1/law/statutes/facets") {
        return Response.json({ documentType: [] });
      }
      return undefined;
    };
    const runtime = await mountStatutes(fixture);
    try {
      await fixture.waitFor(() => {
        expect(document.querySelector('[role="alert"]')).not.toBeNull();
        expect(button("Filters")).not.toBeNull();
        expect(button("Retry")).toBeNull();
      });
      expect(searchInput()).not.toBeNull();
      expect(runtime.caughtErrors.some((error) => APIError.is(error) && error.status === 400)).toBe(true);
    } finally {
      await unmountStatutes(fixture, runtime);
    }
  });

  test("a statute row render failure leaves the toolbar and search usable", async () => {
    fixture.state.audience = "anonymous";
    fixture.state.response = (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/law/statutes") {
        return Response.json({
          ...statutesResponse,
          items: [{ ...statute, title: { invalid: "React child" } }],
        });
      }
      if (pathname === "/v1/law/statutes/facets") {
        return Response.json({ documentType: [] });
      }
      return undefined;
    };
    const runtime = await mountStatutes(fixture);
    try {
      await fixture.waitFor(() => {
        expect(document.body.textContent).toContain("Something went wrong");
        expect(searchInput()).not.toBeNull();
        expect(button("Filters")).not.toBeNull();
        expect(document.body.textContent).toContain("Page 1");
      });
      expect(
        runtime.caughtErrors.some((error) =>
          error.message.includes("title.replace is not a function"),
        ),
      ).toBe(true);
    } finally {
      await unmountStatutes(fixture, runtime);
    }
  });
};

async function mountStatutes(
  fixture: FixtureRuntime,
  initialEntry = "/law/cze/statutes",
) {
  const runtime = fixture.createFixtureRouter(initialEntry);
  runtime.queryClient.setDefaultOptions({ queries: { retry: false } });
  await fixture.initializeI18n();
  await fixture.act(async () => {
    await runtime.router.load();
    fixture.render(<fixture.RouterProvider router={runtime.router} />, {
      container: document,
      onCaughtError: (error) => {
        runtime.caughtErrors.push(
          error instanceof Error ? error : panic(String(error)),
        );
      },
    });
  });
  await fixture.waitFor(() => expect(searchInput()).not.toBeNull());
  return runtime;
}

function searchInput() {
  const input = document.querySelector('input[type="search"]');
  if (!(input instanceof HTMLInputElement)) {
    return panic("The statute search input must exist");
  }
  return input;
}

function button(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent.includes(label),
    ) ?? null
  );
}

async function unmountStatutes(
  fixture: FixtureRuntime,
  runtime: Awaited<ReturnType<typeof mountStatutes>>,
) {
  await fixture.act(async () => {
    await runtime.queryClient.cancelQueries();
    runtime.queryClient.clear();
    fixture.cleanup();
  });
  delete fixture.state.response;
}
