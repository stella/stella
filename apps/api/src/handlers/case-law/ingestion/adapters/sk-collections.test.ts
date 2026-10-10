import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { courtAbbreviation } from "@stll/api-contract/court-abbreviations";

import {
  joinSkCollectionRecords,
  parseSkCollectionPages,
} from "@/api/handlers/case-law/ingestion/adapters/sk-collection-parser";
import { createSkCollectionConnector } from "@/api/handlers/case-law/ingestion/adapters/sk-collections";
import {
  SK_COLLECTION_SERIES,
  SK_COLLECTION_PARSER_VERSION,
  SkCollectionIssueError,
  type SkCollectionIssueCache,
} from "@/api/lib/legal-search/sk-collection-enrichment";

import samples from "./__fixtures__/sk-collection-headnotes.json";

// Only permitted excerpts from cached publisher issues; no compiled PDF fixture.
const samplePages = (index: number) => {
  const sample = samples.at(index);
  if (sample === undefined) {
    throw new SkCollectionIssueError({
      message: "Missing cached sample",
      issueUrl: "",
    });
  }
  return sample.pages;
};

const NS_ISSUE = {
  series: SK_COLLECTION_SERIES.NS_R,
  year: 2026,
  url: "https://www.nsud.sk/data/att/a6d/852249.f832ba.pdf",
} as const;
const NSS_ISSUE = {
  series: SK_COLLECTION_SERIES.NSS_ZNSS,
  year: 2026,
  url: "https://www.nssud.sk/wp-content/uploads/Zbierka_2026_1-sprist.pdf",
} as const;

describe("publisher collection enrichment", () => {
  test("keeps Czech court-name matching unchanged", () => {
    expect(courtAbbreviation({ country: "CZE", court: "Nejvyšší soud" })).toBe(
      "NS",
    );
    expect(
      courtAbbreviation({ country: "CZE", court: "Nejvyšší správní soud" }),
    ).toBe("NSS");
    expect(
      courtAbbreviation({
        country: "CZE",
        court: "Najvyššieho súdu Slovenskej republiky",
      }),
    ).toBeUndefined();
  });
  test.each([
    {
      issue: NS_ISSUE,
      index: 0,
      number: "1.",
      docket: "1VCdo/5/2025",
      page: 3,
    },
    {
      issue: NSS_ISSUE,
      index: 1,
      number: "104/2026 ZNSS",
      docket: "1 Stk 22/2022",
      page: 6,
    },
  ])(
    "keeps the $issue.series headnote, number and source verbatim",
    ({ issue, index, number, docket, page }) => {
      const parsed = parseSkCollectionPages(issue, samplePages(index));
      expect(parsed.status).toBe("parsed");
      if (parsed.status !== "parsed") {
        throw new SkCollectionIssueError({
          message: "Sample did not parse",
          issueUrl: issue.url,
        });
      }
      expect(parsed.records).toHaveLength(1);
      const record = parsed.records.at(0);
      expect(record?.annotation.statedNumber).toBe(number);
      expect(record?.annotation.source).toEqual({ issueUrl: issue.url, page });
      expect(record?.target.docket).toBe(docket);
      const lines = samplePages(index).at(0)?.lines ?? [];
      const sentenceLines = lines
        .slice(
          lines.findIndex(
            (line) => line === "ROZHODNUTIE" || line === "Právna veta",
          ) + 1,
          lines.findIndex((line) => /^[([]/u.test(line)),
        )
        .join("\n")
        .trim();
      expect(record?.annotation.legalSentence).toBe(sentenceLines);
      expect(Object.keys(record?.annotation ?? {}).toSorted()).toEqual([
        "legalSentence",
        "publicationYear",
        "series",
        "source",
        "statedNumber",
      ]);
      expect(JSON.stringify(parsed)).not.toContain("Z odôvodnenia");
    },
  );

  test("joins only the unique SK docket and deciding court, and never mutates a decision", () => {
    const parsed = parseSkCollectionPages(NS_ISSUE, samplePages(0));
    if (parsed.status !== "parsed") {
      throw new SkCollectionIssueError({
        message: "Sample did not parse",
        issueUrl: NS_ISSUE.url,
      });
    }
    const decision = {
      id: "ns",
      country: "SVK",
      court: "Najvyšší súd SR",
      caseNumber: "1 VCdo 5/2025",
      ecli: null,
      decisionDate: "2025-12-03",
    };
    const before = JSON.stringify(decision);
    expect(
      joinSkCollectionRecords(parsed.records, [decision]).at(0)?.status,
    ).toBe("matched");
    expect(JSON.stringify(decision)).toBe(before);
    for (const changed of [
      { ...decision, country: "CZE" },
      { ...decision, decisionDate: "2025-12-04" },
      { ...decision, decisionDate: null },
      { ...decision, caseNumber: "1VCdo/6/2025" },
      { ...decision, court: "Najvyšší správny súd SR" },
    ]) {
      expect(
        joinSkCollectionRecords(parsed.records, [changed]).at(0)?.status,
      ).toBe("unmatched");
    }
    expect(
      joinSkCollectionRecords(parsed.records, [
        decision,
        { ...decision, id: "duplicate" },
      ]).at(0)?.status,
    ).toBe("ambiguous");
    expect(joinSkCollectionRecords(parsed.records, [decision])).toEqual(
      joinSkCollectionRecords(parsed.records, [decision]),
    );
  });

  test("reports scans, early issues and contradictory publication numbers explicitly", () => {
    expect(
      parseSkCollectionPages({ ...NS_ISSUE, year: 1997 }, samplePages(0)),
    ).toEqual({ status: "needs-ocr", reason: "before-2010" });
    expect(parseSkCollectionPages(NS_ISSUE, [{ page: 1, lines: [] }])).toEqual({
      status: "needs-ocr",
      reason: "image-only",
    });
    const changed = samplePages(1).map((page) => ({
      page: page.page,
      lines: page.lines.map((line) =>
        line === "104/2026 ZNSS" ? "104/2025 ZNSS" : line,
      ),
    }));
    expect(parseSkCollectionPages(NSS_ISSUE, changed)).toEqual({
      status: "defective",
      defects: [
        {
          type: "number-year-conflict",
          page: 6,
          statedNumber: "104/2025 ZNSS",
        },
      ],
    });
  });

  test("keeps NSS collection numbers separate and joins the printed spaced docket", () => {
    const parsed = parseSkCollectionPages(NSS_ISSUE, samplePages(1));
    if (parsed.status !== "parsed") {
      throw new SkCollectionIssueError({
        message: "Sample did not parse",
        issueUrl: NSS_ISSUE.url,
      });
    }
    const joined = joinSkCollectionRecords(parsed.records, [
      {
        id: "nss",
        country: "SVK",
        court: "Najvyšší správny súd SR",
        caseNumber: "1Stk/22/2022",
        ecli: null,
        decisionDate: "2022-03-28",
      },
    ]).at(0);
    expect(joined?.status).toBe("matched");
    if (joined?.status !== "matched") {
      throw new SkCollectionIssueError({
        message: "Sample did not join",
        issueUrl: NSS_ISSUE.url,
      });
    }
    expect(joined.annotation.series).toBe(SK_COLLECTION_SERIES.NSS_ZNSS);
    expect(joined.annotation.statedNumber).toBe("104/2026 ZNSS");
  });

  test("classifies a PDF without a text layer through the real extractor", async () => {
    const pdf = PDF.create();
    pdf.addPage();
    const bytes = await pdf.save();
    const connector = createSkCollectionConnector({
      status: "enabled",
      request: async ({ url }) =>
        url.endsWith("/robots.txt")
          ? new Response(null, { status: 404 })
          : new Response(bytes),
    });
    const result = (
      await connector.readIssue({ issue: NS_ISSUE, cache: null })
    ).unwrap();
    expect(result.status).toBe("read");
    if (result.status !== "read") {
      throw new SkCollectionIssueError({
        message: "Blank PDF did not read",
        issueUrl: NS_ISSUE.url,
      });
    }
    expect(result.cache.outcome).toEqual({
      status: "needs-ocr",
      reason: "image-only",
    });
  });

  test("disabled enrichment and cached validator-free issues cost no network calls", async () => {
    const forbidden = async () => {
      throw new SkCollectionIssueError({
        message: "Network must not be reached",
        issueUrl: NS_ISSUE.url,
      });
    };
    const disabled = createSkCollectionConnector({
      status: "disabled",
      request: forbidden,
    });
    expect(
      (await disabled.readIssue({ issue: NS_ISSUE, cache: null })).unwrap(),
    ).toEqual({ status: "disabled" });
    const cache = {
      issue: NS_ISSUE,
      parserVersion: SK_COLLECTION_PARSER_VERSION,
      etag: null,
      lastModified: null,
      outcome: parseSkCollectionPages(NS_ISSUE, samplePages(0)),
    } satisfies SkCollectionIssueCache;
    const enabled = createSkCollectionConnector({
      status: "enabled",
      request: forbidden,
    });
    expect(
      (await enabled.readIssue({ issue: NS_ISSUE, cache })).unwrap(),
    ).toEqual({ status: "unchanged", cache });
  });

  test("validates cached issues without downloading an unchanged PDF", async () => {
    const cache = {
      issue: NS_ISSUE,
      parserVersion: SK_COLLECTION_PARSER_VERSION,
      etag: '"sample"',
      lastModified: null,
      outcome: parseSkCollectionPages(NS_ISSUE, samplePages(0)),
    } satisfies SkCollectionIssueCache;
    const connector = createSkCollectionConnector({
      status: "enabled",
      request: async ({ url, method, headers }) => {
        expect(headers.get("user-agent")).toContain(
          "https://github.com/stella/stella",
        );
        if (url.endsWith("/robots.txt")) {
          return new Response(null, { status: 404 });
        }
        expect(method).toBe("HEAD");
        expect(headers.get("if-none-match")).toBe(cache.etag);
        return new Response(null, { status: 304 });
      },
    });
    expect(
      (await connector.readIssue({ issue: NS_ISSUE, cache })).unwrap(),
    ).toEqual({ status: "unchanged", cache });
  });

  test.each([
    "User-agent: *\nDisallow: /data/att/",
    "User-agent: *\nAllow: /\nUser-agent: stella-collections\nDisallow: /",
    "User-agent: *\nCrawl-delay: 10\nAllow: /",
  ])(
    "obeys publisher restrictions before any issue download: %s",
    async (robots) => {
      const connector = createSkCollectionConnector({
        status: "enabled",
        request: async ({ url }) => {
          expect(url.endsWith("/robots.txt")).toBe(true);
          return new Response(robots);
        },
      });
      expect(
        (await connector.readIssue({ issue: NS_ISSUE, cache: null })).unwrap()
          .status,
      ).toBe("robots-denied");
    },
  );

  test("returns only extracted annotations and validators from a transient download", async () => {
    const connector = createSkCollectionConnector({
      status: "enabled",
      extract: async () => Result.ok(samplePages(0)),
      request: async ({ url }) =>
        url.endsWith("/robots.txt")
          ? new Response("User-agent: *\nAllow: /")
          : new Response("%PDF-transient", { headers: { etag: '"sample"' } }),
    });
    const outcome = (
      await connector.readIssue({ issue: NS_ISSUE, cache: null })
    ).unwrap();
    expect(outcome.status).toBe("read");
    expect(JSON.stringify(outcome)).not.toContain("%PDF-transient");
    expect(JSON.stringify(outcome)).not.toContain('"lines"');
  });

  test("rejects off-origin URLs and cache identity mismatches before a request", async () => {
    const connector = createSkCollectionConnector({
      status: "enabled",
      request: async () => {
        throw new SkCollectionIssueError({
          message: "must not be reached",
          issueUrl: NS_ISSUE.url,
        });
      },
    });
    for (const url of [
      "http://www.nsud.sk/data/att/x.pdf",
      "https://www.nsud.sk.evil.test/data/att/x.pdf",
      "https://www.nsud.sk:444/data/att/x.pdf",
      "https://www.nsud.sk/data/att/%2e%2e/x.pdf",
    ]) {
      const result = await connector.readIssue({
        issue: { ...NS_ISSUE, url },
        cache: null,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toBe(
          "Invalid collection issue descriptor",
        );
      }
    }
    const cache = {
      issue: NSS_ISSUE,
      parserVersion: SK_COLLECTION_PARSER_VERSION,
      etag: null,
      lastModified: null,
      outcome: parseSkCollectionPages(NSS_ISSUE, samplePages(1)),
    } satisfies SkCollectionIssueCache;
    const mismatch = await connector.readIssue({ issue: NS_ISSUE, cache });
    expect(mismatch.isErr()).toBe(true);
    if (mismatch.isErr()) {
      expect(mismatch.error.message).toBe(
        "Cached collection issue identity differs",
      );
    }
  });

  test("surfaces upstream failure explicitly", async () => {
    const connector = createSkCollectionConnector({
      status: "enabled",
      request: async () => new Response(null, { status: 503 }),
    });
    const result = await connector.readIssue({ issue: NS_ISSUE, cache: null });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("Robots request failed (503)");
    }
  });

  test.each(["Z odôvodnenia", "2."])(
    "a missing citation stops at %s while the next entry survives",
    (boundary) => {
      const first = samplePages(0).at(0);
      if (first === undefined) {
        throw new SkCollectionIssueError({
          message: "Missing fixture",
          issueUrl: NS_ISSUE.url,
        });
      }
      const second = first.lines.map((line) => (line === "1." ? "2." : line));
      const lines = [
        "OBSAH",
        "1.",
        "2.",
        "REGISTER",
        "R 3/2026",
        ...first.lines.slice(0, -1),
        boundary,
        "Surrounding decision prose must never be stored.",
        ...second,
      ];
      const parsed = parseSkCollectionPages(NS_ISSUE, [{ page: 3, lines }]);
      expect(parsed.status).toBe("partial");
      if (parsed.status === "partial") {
        expect(parsed.records).toHaveLength(1);
        expect(parsed.records.at(0)?.annotation.statedNumber).toBe("2.");
        expect(parsed.defects).toEqual([
          { type: "unreadable-entry", page: 3, statedNumber: "1." },
        ]);
        expect(JSON.stringify(parsed)).not.toContain(
          "Surrounding decision prose",
        );
      }
    },
  );

  test("multi-entry NSS issues ignore contents numbers and preserve both annotations", () => {
    const first = samplePages(1).at(0);
    if (first === undefined) {
      throw new SkCollectionIssueError({
        message: "Missing fixture",
        issueUrl: NSS_ISSUE.url,
      });
    }
    const parsed = parseSkCollectionPages(NSS_ISSUE, [
      {
        page: 2,
        lines: ["OBSAH", "104/2026 ZNSS", "105/2026 ZNSS", "REGISTER"],
      },
      first,
      {
        page: 7,
        lines: first.lines.map((line) =>
          line === "104/2026 ZNSS" ? "105/2026 ZNSS" : line,
        ),
      },
    ]);
    expect(parsed.status).toBe("partial");
    if (parsed.status === "partial") {
      expect(
        parsed.records.map(({ annotation }) => annotation.statedNumber),
      ).toEqual(["104/2026 ZNSS", "105/2026 ZNSS"]);
      expect(parsed.defects).toEqual([
        { type: "needs-ocr", page: 2, statedNumber: "" },
      ]);
    }
  });

  test("mixed scanned/text pages report each unreadable page and retain good entries", () => {
    const parsed = parseSkCollectionPages(NS_ISSUE, [
      ...samplePages(0),
      { page: 4, lines: [] },
    ]);
    expect(parsed.status).toBe("partial");
    if (parsed.status === "partial") {
      expect(parsed.records).toHaveLength(1);
      expect(parsed.defects).toEqual([
        { type: "needs-ocr", page: 4, statedNumber: "" },
      ]);
    }
  });

  test("oversized legal sentences are refused rather than stored", () => {
    const parsed = parseSkCollectionPages(NS_ISSUE, [
      {
        page: 3,
        lines: [
          "1.",
          "ROZHODNUTIE",
          "x".repeat(3001),
          "(rozsudok Najvyššieho súdu Slovenskej republiky z 3. decembra 2025 sp. zn. 1VCdo/5/2025)",
        ],
      },
    ]);
    expect(parsed).toEqual({
      status: "defective",
      defects: [{ type: "unreadable-entry", page: 3, statedNumber: "1." }],
    });
  });

  test.each([405, 501])(
    "unsupported HEAD %s falls back to one conditional GET",
    async (status) => {
      const cache = {
        issue: NS_ISSUE,
        parserVersion: SK_COLLECTION_PARSER_VERSION,
        etag: '"sample"',
        lastModified: null,
        outcome: parseSkCollectionPages(NS_ISSUE, samplePages(0)),
      } satisfies SkCollectionIssueCache;
      const calls: string[] = [];
      const connector = createSkCollectionConnector({
        status: "enabled",
        request: async ({ url, method, headers }) => {
          calls.push(method);
          if (url.endsWith("/robots.txt")) {
            return new Response(
              "User-agent: *\nDisallow: /\nAllow: /data/att/",
            );
          }
          expect(headers.get("if-none-match")).toBe(cache.etag);
          return new Response(null, {
            status: method === "HEAD" ? status : 304,
          });
        },
      });
      expect(
        (await connector.readIssue({ issue: NS_ISSUE, cache })).unwrap(),
      ).toEqual({ status: "unchanged", cache });
      expect(calls).toEqual(["GET", "HEAD", "GET"]);
    },
  );

  test("changed HEAD fallback consumes the GET once and passes citation URL into extraction", async () => {
    const cache = {
      issue: NS_ISSUE,
      parserVersion: SK_COLLECTION_PARSER_VERSION,
      etag: '"old"',
      lastModified: null,
      outcome: parseSkCollectionPages(NS_ISSUE, samplePages(0)),
    } satisfies SkCollectionIssueCache;
    let downloads = 0;
    const connector = createSkCollectionConnector({
      status: "enabled",
      extract: async (_bytes, issueUrl) => {
        expect(issueUrl).toBe(NS_ISSUE.url);
        return Result.ok(samplePages(0));
      },
      request: async ({ url, method }) => {
        if (url.endsWith("/robots.txt")) {
          return new Response(null, { status: 404 });
        }
        if (method === "HEAD") {
          return new Response(null, { status: 405 });
        }
        downloads++;
        return new Response("%PDF-transient", { headers: { etag: '"new"' } });
      },
    });
    expect(
      (await connector.readIssue({ issue: NS_ISSUE, cache })).unwrap().status,
    ).toBe("read");
    expect(downloads).toBe(1);
  });

  test("a parser revision mismatch cannot reuse even a validator-free cached result", async () => {
    const cache = {
      issue: NS_ISSUE,
      parserVersion: SK_COLLECTION_PARSER_VERSION - 1,
      etag: null,
      lastModified: null,
      outcome: parseSkCollectionPages(NS_ISSUE, samplePages(0)),
    } satisfies SkCollectionIssueCache;
    const connector = createSkCollectionConnector({
      status: "enabled",
      extract: async () => Result.ok(samplePages(0)),
      request: async ({ url, method, headers }) => {
        expect(method).toBe("GET");
        expect(headers.has("if-none-match")).toBe(false);
        return url.endsWith("/robots.txt")
          ? new Response(null, { status: 404 })
          : new Response("%PDF-transient");
      },
    });
    const result = (
      await connector.readIssue({ issue: NS_ISSUE, cache })
    ).unwrap();
    expect(result.status).toBe("read");
    if (result.status === "read") {
      expect(result.cache.parserVersion).toBe(SK_COLLECTION_PARSER_VERSION);
    }
  });
  test.each([
    { body: null, message: "Collection response has no body" },
    { body: "invalid", message: "Issue response is not a PDF" },
  ])(
    "propagates typed body validation: $message",
    async ({ body, message }) => {
      const connector = createSkCollectionConnector({
        status: "enabled",
        request: async ({ url }) =>
          url.endsWith("/robots.txt")
            ? new Response(null, { status: 404 })
            : new Response(body),
      });
      const result = await connector.readIssue({
        issue: NS_ISSUE,
        cache: null,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toBe(message);
        expect(result.error.issueUrl).toBe(NS_ISSUE.url);
      }
    },
  );

  test("propagates an extractor's typed failure without replacing its issue citation", async () => {
    const connector = createSkCollectionConnector({
      status: "enabled",
      extract: async (_bytes, issueUrl) =>
        Result.err(
          new SkCollectionIssueError({
            message: "Collection issue exceeds the page limit",
            issueUrl,
          }),
        ),
      request: async ({ url }) =>
        url.endsWith("/robots.txt")
          ? new Response(null, { status: 404 })
          : new Response("%PDF-transient"),
    });
    const result = await connector.readIssue({ issue: NS_ISSUE, cache: null });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(
        "Collection issue exceeds the page limit",
      );
      expect(result.error.issueUrl).toBe(NS_ISSUE.url);
    }
  });
});
