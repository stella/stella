import { expect, test } from "bun:test";
import { panic } from "better-result";

import type { api } from "@/lib/api";
import type { PublicLawData } from "@/lib/public-law-api";
import type { StatuteListItem } from "@/features/statutes/queries/statutes";
import { APIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

import type { FixtureRuntime } from "./route-shell-provider-fixture";

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

async function mountStatutes(fixture: FixtureRuntime) {
  const runtime = fixture.createFixtureRouter("/law/cze/statutes");
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
