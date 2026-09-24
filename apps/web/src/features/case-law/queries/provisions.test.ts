import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  citedWorkAtDateKey,
  decisionProvisionsForLinkingOptions,
  statuteByCitedWork,
  statutesResolveOptions,
} from "@/features/case-law/queries/provisions";

const LISTINA_ELI = "https://www.e-sbirka.cz/eli/cz/sb/1993/2";
const previousFetch = globalThis.fetch;

const statute = {
  country: "CZE",
  eli: LISTINA_ELI,
  id: "01a02a37-1111-7111-8111-111111111111",
  language: "cs",
  slug: "2-1993-sb",
  title: "2/1993 Sb., Listina základních práv a svobod",
  versionValidFrom: "1993-01-01",
  versionValidTo: null,
};

afterEach(() => {
  globalThis.fetch = previousFetch;
});

const resolveRequestSchema = v.object({
  works: v.array(
    v.object({ asOf: v.string(), country: v.string(), eli: v.string() }),
  ),
});
type ResolveRequest = v.InferOutput<typeof resolveRequestSchema>;

/**
 * Stands in for the batched resolve: answers each requested work with the
 * statute `answer` names for its ELI, or null, and records every body sent.
 */
const mockResolve = (answer: (eli: string) => typeof statute | null) => {
  const bodies: ResolveRequest[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toEndWith("/law/statutes/resolve");
      expect(request.method).toBe("POST");
      const body = v.parse(resolveRequestSchema, await request.json());
      bodies.push(body);
      return new Response(
        JSON.stringify({
          items: body.works.map(({ asOf, country, eli }) => ({
            asOf,
            country,
            eli,
            statute: answer(eli),
          })),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
    { preconnect: previousFetch.preconnect },
  );
  return bodies;
};

const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("cited statute resolution", () => {
  test("resolves every cited work in one request and keys each answer by its request", async () => {
    const bodies = mockResolve((eli) => (eli === LISTINA_ELI ? statute : null));
    const works = Array.from({ length: 30 }, (_, index) => ({
      asOf: "2011-03-22",
      country: "CZE",
      eli:
        index === 0
          ? LISTINA_ELI
          : `https://www.e-sbirka.cz/eli/cz/sb/1993/${String(100 + index)}`,
    }));

    const resolved = await newQueryClient().query(
      statutesResolveOptions([...works, ...works]),
    );
    const statutes = statuteByCitedWork(resolved);

    // One request past the old per-work fan-out, with each work once.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.works).toHaveLength(works.length);
    const resolvedId: string | undefined = statutes.get(
      citedWorkAtDateKey({
        asOf: "2011-03-22",
        country: "CZE",
        eli: LISTINA_ELI,
      }),
    )?.id;
    expect(resolvedId).toBe(statute.id);
    // An unheld work is absent, and the same work at another date is another
    // question.
    expect(statutes.size).toBe(1);
    expect(
      statutes.has(
        citedWorkAtDateKey({
          asOf: "2020-01-01",
          country: "CZE",
          eli: LISTINA_ELI,
        }),
      ),
    ).toBe(false);
  });

  test("splits a set past the endpoint maximum and answers all of it", async () => {
    const bodies = mockResolve(() => statute);
    const works = Array.from({ length: 201 }, (_, index) => ({
      asOf: "2011-03-22",
      country: "CZE",
      eli: `https://www.e-sbirka.cz/eli/cz/sb/2001/${String(index + 1)}`,
    }));

    const resolved = await newQueryClient().query(
      statutesResolveOptions(works),
    );

    expect(
      bodies.map((body) => body.works.length).toSorted((a, b) => a - b),
    ).toEqual([1, 200]);
    expect(statuteByCitedWork(resolved).size).toBe(201);
  });

  test("names the same set of works by one key, whatever their order", () => {
    const first = { asOf: "2011-03-22", country: "CZE", eli: LISTINA_ELI };
    const second = {
      asOf: "2011-03-22",
      country: "CZE",
      eli: "https://www.e-sbirka.cz/eli/cz/sb/1993/20",
    };

    expect(statutesResolveOptions([first, second]).queryKey).toEqual(
      statutesResolveOptions([second, first, second]).queryKey,
    );
    expect(statutesResolveOptions([first]).queryKey).not.toEqual(
      statutesResolveOptions([{ ...first, asOf: "2020-01-01" }]).queryKey,
    );
  });
});

describe("provisions for inline linking", () => {
  test("reads references past the first page", async () => {
    const cursors: (string | null)[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        return new Response(
          JSON.stringify(
            cursor === null
              ? {
                  items: [{ anchor: "par_31-odst_4", spanStart: 120 }],
                  limit: 100,
                  nextCursor: "next",
                  previews: [],
                }
              : {
                  items: [{ anchor: "par_70-odst_2", spanStart: 28_592 }],
                  limit: 100,
                  nextCursor: null,
                  previews: [],
                },
          ),
          { headers: { "Content-Type": "application/json" } },
        );
      },
      { preconnect: previousFetch.preconnect },
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { items } = await queryClient.query(
      decisionProvisionsForLinkingOptions(
        "019ffba6-1445-7000-bd47-9268acb7ba92",
      ),
    );

    expect(items.map((item) => item.anchor)).toEqual([
      "par_31-odst_4",
      "par_70-odst_2",
    ]);
    expect(cursors).toEqual([null, "next"]);
  });
});
