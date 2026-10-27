import { afterEach, expect, setSystemTime, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { fetchUkFclDecision, UK_FCL_COURTS, ukFclAdapter } from "./uk-fcl";
import { readUkFclFeed } from "./uk-fcl-feed";

const feed = await Bun.file(
  new URL("__fixtures__/uk-fcl.atom.xml", import.meta.url),
).text();
const document = await Bun.file(
  new URL("../parsers/__fixtures__/uk-fcl.xml", import.meta.url),
).text();
const entry = readUkFclFeed(feed, 50).unwrap().entries.at(0);
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setSystemTime();
});

test("next links alone determine pagination and other origins fail before a request", async () => {
  const paged = feed.replace(
    "</feed>",
    '<link rel="last" href="/atom.xml?page=999"/><link rel="next" href="/atom.xml?page=2"/></feed>',
  );
  expect(readUkFclFeed(paged, 50).unwrap().next).toBe(
    "https://caselaw.nationalarchives.gov.uk/atom.xml?page=2",
  );
  expect(
    readUkFclFeed(
      feed.replace(
        "</feed>",
        '<link rel="last" href="/atom.xml?page=999"/></feed>',
      ),
      50,
    ).unwrap().next,
  ).toBeNull();
  let requests = 0;
  globalThis.fetch = asFetchMock(() => {
    requests++;
    return Promise.resolve(new Response(feed));
  });
  const refused = await ukFclAdapter.fetchPage(
    JSON.stringify({
      type: "tip",
      frontier: "2026-01-01T00:00:00Z",
      pending: "2026-01-01T00:00:00Z",
      url: "https://example.test/atom.xml",
    }),
    {},
  );
  expect(refused.isErr()).toBe(true);
  expect(requests).toBe(0);
});

test("daily watermark includes ties and advances after the complete page", async () => {
  const calls: string[] = [];
  globalThis.fetch = asFetchMock((input) => {
    const url = String(input);
    calls.push(url);
    return Promise.resolve(
      new Response(url.endsWith("/data.xml") ? document : feed),
    );
  });
  const frontier = entry?.updated ?? "";
  const page = await ukFclAdapter.fetchPage(
    JSON.stringify({
      type: "tip",
      frontier,
      pending: frontier,
      url: "https://caselaw.nationalarchives.gov.uk/atom.xml?order=-transformation&per_page=50",
    }),
    {},
  );
  const value = page.unwrap();
  expect(value.decisions).toHaveLength(1);
  expect(calls).toHaveLength(2);
  expect(JSON.parse(value.nextCursor ?? "null")).toMatchObject({
    type: "tip",
    frontier,
  });
  expect(UK_FCL_COURTS).toContain("ewhc/bp");
});

test("failed detail requests hold the page checkpoint", async () => {
  globalThis.fetch = asFetchMock((input) =>
    Promise.resolve(
      new Response(String(input).endsWith("/data.xml") ? "" : feed, {
        status: String(input).endsWith("/data.xml") ? 404 : 200,
      }),
    ),
  );
  const page = await ukFclAdapter.fetchPage(
    JSON.stringify({
      type: "tip",
      frontier: "2026-01-01T00:00:00Z",
      pending: "2026-01-01T00:00:00Z",
      url: "https://caselaw.nationalarchives.gov.uk/atom.xml",
    }),
    {},
  );
  expect(page.isErr()).toBe(true);
});

const origin = "https://caselaw.nationalarchives.gov.uk";
const emptyFeed = '<feed xmlns="http://www.w3.org/2005/Atom"/>';
const boundary = "2026-01-03T12:00:00Z";
const sweep = (
  overrides: { year?: number; court?: number; url?: string } = {},
) =>
  JSON.stringify({
    type: "sweep",
    boundary,
    year: 2001,
    court: 0,
    url: `${origin}/atom.xml?court=uksc`,
    ...overrides,
  });

test("backfill snapshots the daily frontier and walks the listed continuation before the next court", async () => {
  const calls: URL[] = [];
  globalThis.fetch = asFetchMock(async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith("/data.xml")) {
      return new Response(document);
    }
    if (url.searchParams.get("order") === "-transformation") {
      return new Response(feed);
    }
    return new Response(
      feed.replace(
        "</feed>",
        '<link rel="next" href="/atom.xml?court=uksc&amp;page=2"/></feed>',
      ),
    );
  });
  const first = (await ukFclAdapter.fetchPage(null, {})).unwrap();
  expect(first.decisions).toHaveLength(1);
  expect(calls[0]?.searchParams.getAll("court")).toEqual(UK_FCL_COURTS);
  expect(calls[1]?.searchParams.get("from_date_2")).toBe("2001");
  expect(JSON.parse(first.nextCursor ?? "null")).toEqual({
    type: "sweep",
    boundary,
    year: 2001,
    court: 0,
    url: `${origin}/atom.xml?court=uksc&page=2`,
  });
  calls.length = 0;
  globalThis.fetch = asFetchMock(async (input) => {
    calls.push(new URL(String(input)));
    return new Response(String(input).endsWith("/data.xml") ? document : feed);
  });
  const second = (await ukFclAdapter.fetchPage(first.nextCursor, {})).unwrap();
  expect(calls.at(0)?.searchParams.get("page")).toBe("2");
  expect(JSON.parse(second.nextCursor ?? "null")).toMatchObject({
    type: "sweep",
    boundary,
    year: 2001,
    court: 1,
  });
});

test("the final backfill slice resumes daily discovery from its original frontier", async () => {
  setSystemTime(new Date("2026-10-01T00:00:00Z"));
  globalThis.fetch = asFetchMock(
    async (input) =>
      new Response(String(input).endsWith("/data.xml") ? document : feed),
  );
  const page = (
    await ukFclAdapter.fetchPage(
      sweep({ year: 2026, court: UK_FCL_COURTS.length - 1 }),
      {},
    )
  ).unwrap();
  expect(JSON.parse(page.nextCursor ?? "null")).toMatchObject({
    type: "tip",
    frontier: boundary,
    pending: boundary,
  });
  expect(page.decisions).toHaveLength(1);
});

test("daily pagination retains its old frontier until every tied entry is read", async () => {
  const frontier = "2026-01-02T00:00:00Z";
  const newest = "2026-01-04T12:00:00Z";
  const firstFeed = feed
    .replace(boundary, () => newest)
    .replace("</feed>", '<link rel="next" href="/atom.xml?page=2"/></feed>');
  let calls = 0;
  globalThis.fetch = asFetchMock(async (input) => {
    calls++;
    return new Response(
      String(input).endsWith("/data.xml") ? document : firstFeed,
    );
  });
  const first = (
    await ukFclAdapter.fetchPage(
      JSON.stringify({
        type: "tip",
        frontier,
        pending: frontier,
        url: `${origin}/atom.xml`,
      }),
      {},
    )
  ).unwrap();
  expect(JSON.parse(first.nextCursor ?? "null")).toMatchObject({
    type: "tip",
    frontier,
    pending: newest,
  });
  const tiedFeed = feed.replace(boundary, () => frontier);
  globalThis.fetch = asFetchMock(
    async (input) =>
      new Response(String(input).endsWith("/data.xml") ? document : tiedFeed),
  );
  const second = (await ukFclAdapter.fetchPage(first.nextCursor, {})).unwrap();
  expect(second.decisions).toHaveLength(1);
  expect(JSON.parse(second.nextCursor ?? "null")).toMatchObject({
    type: "tip",
    frontier: newest,
    pending: newest,
  });
  globalThis.fetch = asFetchMock(async () => {
    calls++;
    return new Response(emptyFeed);
  });
  const quiet = (await ukFclAdapter.fetchPage(second.nextCursor, {})).unwrap();
  expect(quiet.nextCursor).toBe(second.nextCursor);
  expect(quiet.decisions).toEqual([]);
  expect(calls).toBe(3);
});

test("a full unlinked page and failed later details cannot produce a checkpoint", async () => {
  const match = feed.match(/<entry>[\s\S]*?<\/entry>/u)?.at(0) ?? "";
  const entries = Array.from({ length: 50 }, (_, index) =>
    match.replaceAll(
      "d-00000000-0000-4000-8000-000000000001",
      () => `synthetic-${index}`,
    ),
  ).join("");
  const full = feed.replace(match, () => entries);
  let details = 0;
  globalThis.fetch = asFetchMock(async (input) => {
    if (String(input).endsWith("/data.xml")) {
      details++;
    }
    return new Response(full);
  });
  expect((await ukFclAdapter.fetchPage(sweep(), {})).isErr()).toBe(true);
  expect(details).toBe(0);
  const second = match.replaceAll(
    "d-00000000-0000-4000-8000-000000000001",
    "synthetic-second",
  );
  globalThis.fetch = asFetchMock(async (input) => {
    const url = String(input);
    if (!url.endsWith("/data.xml")) {
      return new Response(feed.replace(match, () => match + second));
    }
    return url.includes("synthetic-second")
      ? new Response("", { status: 404 })
      : new Response(document);
  });
  expect((await ukFclAdapter.fetchPage(sweep(), {})).isErr()).toBe(true);
});

test.each([
  { court: "UKSC", citation: "UKSC", slug: "uksc" },
  { court: "EWCA Civ", citation: "EWCA Civ", slug: "ewca/civ" },
  { court: "EWHC-KB", citation: "EWHC 900001 (KB)", slug: "ewhc/kb" },
])(
  "$court retains its stated court and opaque identity",
  async ({ court, citation, slug }) => {
    const caseNumber = citation.startsWith("EWHC")
      ? `[2026] ${citation}`
      : `[2026] ${citation} 900001`;
    const transform = (value: string) =>
      value
        .replaceAll("[2026] UKSC 900001", () => caseNumber)
        .replace(
          "<uk:court>UKSC</uk:court>",
          () => `<uk:court>${court}</uk:court>`,
        )
        .replaceAll("uksc/2026/900001", () => `${slug}/2026/900001`);
    globalThis.fetch = asFetchMock(
      async () => new Response(transform(document)),
    );
    const result = await fetchUkFclDecision({
      feed: transform(feed),
      sourceDocumentId: entry?.sourceDocumentId ?? "",
    });
    expect(result.court).toBe(court);
    expect(result.caseNumber).toBe(caseNumber);
    expect(result.sourceDocumentId).toBe(entry?.sourceDocumentId);
  },
);

test.each(["2026-00-extra", "2026-", "2026-999", "2000-00"])(
  "reconciliation rejects malformed slice %s",
  async (value) => {
    let requests = 0;
    globalThis.fetch = asFetchMock(async () => {
      requests++;
      return new Response(emptyFeed);
    });
    expect(
      await rejectionOf(
        ukFclAdapter.reconciliation.listSlicePage({ slice: value, page: 0 }),
      ),
    ).toMatchObject({ message: "Invalid decision slice" });
    expect(requests).toBe(0);
  },
);

test("empty backfill work stays bounded and retains the original frontier", async () => {
  let requests = 0;
  globalThis.fetch = asFetchMock(async () => {
    requests++;
    return new Response(emptyFeed);
  });
  const page = (await ukFclAdapter.fetchPage(sweep(), {})).unwrap();
  const next: unknown = JSON.parse(page.nextCursor ?? "null");
  expect(requests).toBe(16);
  expect(page.decisions).toEqual([]);
  expect(next).toMatchObject({ type: "sweep", boundary });
});
