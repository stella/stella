/* eslint-disable typescript-eslint/no-unsafe-type-assertion */
/* eslint-disable typescript-eslint/promise-function-async */
/* eslint-disable typescript-eslint/no-unsafe-assignment */
/* eslint-disable typescript-eslint/no-unsafe-member-access */
import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { czUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-us";

// ── Helpers ──────────────────────────────────────────────

/** Build a minimal NALUS GetText.aspx response. */
const makeTextPage = (caseNumber: string, date: string): string => `
<html><body>
  <span id="lblRegistrySign" class="DocRegistrySign"
    style="font-size:10pt;">${caseNumber} ze dne ${date}</span>
  <span id="lblDecisionForm">Nález</span>
  <table class="DocContent">
    <tr><td>
      ${"Lorem ipsum dolor sit amet. ".repeat(10)}
      Jan Novák (soudce zpravodaj)
    </td></tr>
  </table>
</body></html>`;

/** Build an empty NALUS response (no decision at this number). */
const makeEmptyPage = (): string => `
<html><body>
  <span id="lblRegistrySign" class="DocRegistrySign"
    style="font-size:10pt;"></span>
</body></html>`;

/** Build a minimal GetAbstract.aspx response. */
const makeAbstractPage = (abstract: string): string => `
<html><body>
  <table class="abstractContent"><tr><td>${abstract}</td></tr></table>
  <table class="legalSentenceContent"><tr><td></td></tr></table>
</body></html>`;

const resolveUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

// ── Tests ────────────────────────────────────────────────

describe("czUsAdapter.fetchPage", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  test("null cursor starts at current year and crawls backward", async () => {
    // null cursor → starts at currentYear. Current year has n=1,
    // after 30 misses descends to previous year which has n=1..2.
    const currentYear = new Date().getFullYear();
    const curYr = String(currentYear % 100).padStart(2, "0");
    const prevYr = String((currentYear - 1) % 100).padStart(2, "0");

    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = resolveUrl(input);
      if (url.includes("GetAbstract")) {
        return Promise.resolve(new Response(makeEmptyPage()));
      }
      const match = /sz=I-(\d+)-(\d+)_1/.exec(url);
      const n = match ? Number(match[1]) : 0;
      const yr = match ? Number(match[2]) : 0;

      if (yr === Number(curYr) && n === 1) {
        return Promise.resolve(
          new Response(makeTextPage(`I.ÚS 1/${curYr}`, `1. 1. ${currentYear}`)),
        );
      }
      if (yr === Number(prevYr) && n >= 1 && n <= 2) {
        return Promise.resolve(
          new Response(
            makeTextPage(`II.ÚS ${n}/${prevYr}`, `5. 5. ${currentYear - 1}`),
          ),
        );
      }
      return Promise.resolve(new Response(makeEmptyPage()));
    }) as unknown as typeof fetch;

    // Pass null cursor (the real entry point)
    const result = await czUsAdapter.fetchPage(null, {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }

    const caseNumbers = result.value.decisions.map((d) => d.caseNumber);
    // Should find 1 from current year, then descend to previous year
    expect(caseNumbers).toContain(`I.ÚS 1/${curYr}`);
    expect(caseNumbers).toContain(`II.ÚS 1/${prevYr}`);
    expect(caseNumbers).toContain(`II.ÚS 2/${prevYr}`);
  });

  test("collects decisions from sequential numbers", async () => {
    // Year 2025: numbers 1-5 have decisions, rest are empty.
    const hitNumbers = new Set([1, 2, 3, 4, 5]);

    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = resolveUrl(input);
      if (url.includes("GetAbstract")) {
        return Promise.resolve(new Response(makeEmptyPage()));
      }
      const match = /sz=I-(\d+)-(\d+)_1/.exec(url);
      const n = match ? Number(match[1]) : 0;
      const yr = match ? Number(match[2]) : 0;
      const body =
        yr === 25 && hitNumbers.has(n)
          ? makeTextPage(`II.ÚS ${n}/25`, "1. 1. 2025")
          : makeEmptyPage();
      return Promise.resolve(new Response(body));
    }) as unknown as typeof fetch;

    const result = await czUsAdapter.fetchPage("1:2025", {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }

    expect(result.value.decisions).toHaveLength(5);
    expect(result.value.decisions[0]?.caseNumber).toBe("II.ÚS 1/25");
    expect(result.value.decisions[4]?.caseNumber).toBe("II.ÚS 5/25");
  });

  test("moves to previous year after consecutive misses", async () => {
    // Year 2025: only n=1 has a decision.
    // After 30 consecutive misses, adapter moves to 2024.
    // Year 2024: n=1..3 have decisions.
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = resolveUrl(input);
      if (url.includes("GetAbstract")) {
        return Promise.resolve(new Response(makeEmptyPage()));
      }

      const yearMatch = /sz=I-(\d+)-(\d+)_1/.exec(url);
      if (!yearMatch) {
        return Promise.resolve(new Response(makeEmptyPage()));
      }

      const n = Number(yearMatch[1]);
      const yr = Number(yearMatch[2]);

      if (yr === 25 && n === 1) {
        return Promise.resolve(
          new Response(makeTextPage("I.ÚS 1/25", "10. 1. 2025")),
        );
      }
      if (yr === 24 && n >= 1 && n <= 3) {
        return Promise.resolve(
          new Response(makeTextPage(`III.ÚS ${n}/24`, "15. 3. 2024")),
        );
      }

      return Promise.resolve(new Response(makeEmptyPage()));
    }) as unknown as typeof fetch;

    const result = await czUsAdapter.fetchPage("1:2025", {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }

    const caseNumbers = result.value.decisions.map((d) => d.caseNumber);

    expect(caseNumbers).toContain("I.ÚS 1/25");
    expect(caseNumbers).toContain("III.ÚS 1/24");
    expect(caseNumbers).toContain("III.ÚS 2/24");
    expect(caseNumbers).toContain("III.ÚS 3/24");
  });

  test("parks cursor at current year after reaching 1993", async () => {
    // Only year 1993 (93): n=1 has a decision.
    // After 30 misses at FIRST_YEAR, cursor should park at
    // the current year (not null) to avoid re-scanning history.
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = resolveUrl(input);
      if (url.includes("GetAbstract")) {
        return Promise.resolve(new Response(makeEmptyPage()));
      }

      const match = /sz=I-(\d+)-93_1/.exec(url);
      if (match && Number(match[1]) === 1) {
        return Promise.resolve(
          new Response(makeTextPage("I.ÚS 1/93", "11. 11. 1993")),
        );
      }

      return Promise.resolve(new Response(makeEmptyPage()));
    }) as unknown as typeof fetch;

    const result = await czUsAdapter.fetchPage("1:1993", {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }

    expect(result.value.decisions).toHaveLength(1);
    expect(result.value.decisions[0]?.caseNumber).toBe("I.ÚS 1/93");
    // Must NOT be null — parks at current year
    const currentYear = new Date().getFullYear();
    expect(result.value.nextCursor).toBe(`1:${currentYear}`);
  });

  test("respects PAGE_SIZE limit", async () => {
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = resolveUrl(input);
      if (url.includes("GetAbstract")) {
        return Promise.resolve(new Response(makeEmptyPage()));
      }
      const match = /sz=I-(\d+)-25_1/.exec(url);
      const n = match ? Number(match[1]) : 0;
      return Promise.resolve(
        new Response(makeTextPage(`I.ÚS ${n}/25`, "1. 6. 2025")),
      );
    }) as unknown as typeof fetch;

    const result = await czUsAdapter.fetchPage("1:2025", {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }

    expect(result.value.decisions).toHaveLength(50);
    expect(result.value.nextCursor).toBe("51:2025");
  });

  test("abstract failure does not drop the decision", async () => {
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = resolveUrl(input);
      if (url.includes("GetAbstract")) {
        return Promise.reject(new Error("Network error"));
      }
      const match = /sz=I-(\d+)-/.exec(url);
      const n = match ? Number(match[1]) : 0;
      if (n === 1) {
        return Promise.resolve(
          new Response(makeTextPage("IV.ÚS 1/25", "5. 2. 2025")),
        );
      }
      return Promise.resolve(new Response(makeEmptyPage()));
    }) as unknown as typeof fetch;

    const result = await czUsAdapter.fetchPage("1:2025", {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }

    const decision = result.value.decisions.find(
      (d) => d.caseNumber === "IV.ÚS 1/25",
    );
    expect(decision).toBeDefined();
    // eslint-disable-next-line unicorn/no-useless-undefined
    expect(decision?.metadata["abstract"]).toEqual(undefined);
  });

  test("enriches decision with abstract when available", async () => {
    const longAbstract =
      "Právo na spravedlivý proces zahrnuje právo na " +
      "odůvodnění soudního rozhodnutí, které musí být " +
      "přezkoumatelné a dostatečně podrobné.";

    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = resolveUrl(input);
      if (url.includes("GetAbstract")) {
        return Promise.resolve(new Response(makeAbstractPage(longAbstract)));
      }
      const match = /sz=I-(\d+)-/.exec(url);
      const n = match ? Number(match[1]) : 0;
      if (n === 1) {
        return Promise.resolve(
          new Response(makeTextPage("I.ÚS 1/25", "1. 1. 2025")),
        );
      }
      return Promise.resolve(new Response(makeEmptyPage()));
    }) as unknown as typeof fetch;

    const result = await czUsAdapter.fetchPage("1:2025", {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }

    const decision = result.value.decisions[0];
    expect(decision?.metadata["abstract"]).toBe(longAbstract);
    const raw = JSON.parse(decision?.sourceRaw ?? "{}");
    expect(raw.textHtml).toBeDefined();
    expect(raw.abstractHtml).toBeDefined();
  });

  test("AbortError preserves partial results", async () => {
    let callCount = 0;

    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = resolveUrl(input);
      if (url.includes("GetAbstract")) {
        return Promise.resolve(new Response(makeEmptyPage()));
      }
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(makeTextPage("I.ÚS 1/25", "1. 1. 2025")),
        );
      }
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }) as unknown as typeof fetch;

    const result = await czUsAdapter.fetchPage("1:2025", {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }

    expect(result.value.decisions).toHaveLength(1);
    expect(result.value.nextCursor).not.toBeNull();
  });

  test("extracts metadata fields from decision page", async () => {
    const body =
      "Ústavní soud rozhodl v plénu složeném z předsedy soudu. ".repeat(5);
    const html = `
<html><body>
  <span id="lblRegistrySign" class="DocRegistrySign"
    style="font-size:10pt;">Pl.ÚS 24/10 ze dne 22. 3. 2011</span>
  <span id="lblDecisionForm">Nález</span>
  <span id="lblParallelQuotation">N 42/60 SbNU 507</span>
  <span id="lblPopularName">Melčák</span>
  <table class="DocContent">
    <tr><td>${body}<p>Pavel Rychetský (soudce zpravodaj)</p></td></tr>
  </table>
</body></html>`;

    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = resolveUrl(input);
      if (url.includes("GetAbstract")) {
        return Promise.resolve(new Response(makeEmptyPage()));
      }
      const match = /sz=I-(\d+)-/.exec(url);
      const n = match ? Number(match[1]) : 0;
      if (n === 1) {
        return Promise.resolve(new Response(html));
      }
      return Promise.resolve(new Response(makeEmptyPage()));
    }) as unknown as typeof fetch;

    const result = await czUsAdapter.fetchPage("1:2010", {});

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }

    const decision = result.value.decisions[0];
    expect(decision).toBeDefined();
    expect(decision?.caseNumber).toBe("Pl.ÚS 24/10");
    expect(decision?.decisionDate).toBe("2011-03-22");
    expect(decision?.decisionType).toBe("nález");
    expect(decision?.court).toBe("Ústavní soud");
    expect(decision?.country).toBe("CZE");
    expect(decision?.language).toBe("cs");
    expect(decision?.metadata["parallelQuotation"]).toBe("N 42/60 SbNU 507");
    expect(decision?.metadata["popularName"]).toBe("Melčák");
    expect(decision?.metadata["judge"]).toContain("Pavel Rychetský");
    expect(decision?.fulltext).toBeDefined();
    expect(decision?.rawHash).toBeDefined();
  });
});
