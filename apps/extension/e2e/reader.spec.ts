import { expect, type Page, test } from "@playwright/test";
import * as v from "valibot";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_TARGET_METADATA,
  ELEMENT_REFERENCE_SHADOW_SEGMENT,
} from "@stll/api-contract/browser-control";

import {
  type FindRequest,
  type PageOperation,
  pageScript,
  type ReaderPosition,
  type ReadRequest,
  SNAPSHOT_PURPOSE,
} from "../src/lib/page-script";
import { frameFoundSchema, frameReadSchema } from "../src/lib/page-window";
import {
  IDENTITY_PROVIDER_HOSTS,
  SIGN_IN_POLICY,
} from "../src/lib/sign-in-policy";

/**
 * The page script against a real page in Chromium, without the extension:
 * the reader's structure, its cost on a long document, and paging that
 * neither skips nor repeats a block.
 */

const ORIGIN = "https://reader.test";

/**
 * Real elapsed time: the bounds below are on the page script's own work in
 * a real browser, which a test clock cannot stand in for.
 */
// oxlint-disable-next-line no-ambient-time-in-tests/no-ambient-time-in-tests -- measures real page work against a stated bound
const wallClock = () => performance.now();

const base = {
  identityProviderHosts: IDENTITY_PROVIDER_HOSTS,
  limits: BROWSER_CONTROL_LIMITS,
  metadataType: BROWSER_CONTROL_TARGET_METADATA,
  shadowSegment: ELEMENT_REFERENCE_SHADOW_SEGMENT,
  signIn: SIGN_IN_POLICY.withholdSecrets,
  signInPolicies: SIGN_IN_POLICY,
} as const;

const readRequest = (
  position: ReadRequest["position"],
  direction: ReadRequest["direction"] = "forward",
): ReadRequest => ({
  direction,
  firstLinkNumber: 1,
  maxChars: BROWSER_CONTROL_LIMITS.pageTextChars,
  maxControls: BROWSER_CONTROL_LIMITS.elements,
  maxLinks: BROWSER_CONTROL_LIMITS.elements,
  position,
});

const serve = async (page: Page, html: string, path: string) => {
  await page.route(`${ORIGIN}/**`, async (route) => {
    await route.fulfill({
      body: html,
      contentType: "text/html; charset=utf-8",
      status: 200,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
};

/** Runs one read in the page, as the extension injects it, and times it. */
const read = async (page: Page, request: ReadRequest | undefined) => {
  const operation: PageOperation = {
    ...base,
    facts: true,
    kind: "snapshot",
    pageControls: BROWSER_CONTROL_LIMITS.elements,
    purpose: SNAPSHOT_PURPOSE.read,
    purposes: SNAPSHOT_PURPOSE,
    ...(request === undefined ? {} : { read: request }),
  };
  const started = wallClock();
  const result: unknown = await page.evaluate(pageScript, operation);
  const elapsed = wallClock() - started;
  return { elapsed, result };
};

const readWindow = async (page: Page, request: ReadRequest) => {
  const { elapsed, result } = await read(page, request);
  const parsed = v.parse(frameReadSchema, result);
  const { window } = parsed;
  if (window === undefined) {
    throw new TypeError("The read returned no window.");
  }
  return { elapsed, page: parsed, window };
};

const find = async (page: Page, request: FindRequest) => {
  const operation: PageOperation = { ...base, find: request, kind: "find" };
  const started = wallClock();
  const result: unknown = await page.evaluate(pageScript, operation);
  return {
    elapsed: wallClock() - started,
    found: v.parse(frameFoundSchema, result).found,
  };
};

const withoutLinkMarks = (line: string) => line.replaceAll(/ ?\[L\d+\]/gu, "");

test("keeps block structure, headings, markers and links", async ({ page }) => {
  await serve(
    page,
    `<!doctype html><html lang="en"><head><title>Structure</title>
<link rel="canonical" href="${ORIGIN}/works/structure">
<meta name="citation_title" content="Structure fixture">
<meta name="author" content="Example Author">
<meta name="viewport" content="width=device-width">
<style>
  .sub { font-weight: 700; }
  .sub::before { content: "\\00A7  "; }
  .counted::before { content: counter(item) ". "; }
</style></head><body>
<h1>Commentary on the notice rules</h1>
<div class="sub">Scope of the rule</div>
<div class="para"><span aria-hidden="true">12</span> The notice period runs from Ver<em>trag</em>sschluss, not from dispatch.<sup>3</sup></div>
<div class="para">See <a href="/works/other#part-2" aria-label="Opens the other work">the other work</a> and <a href="#top" title="t">top</a>.<br>Second line of the block.</div>
<ol start="3"><li>Third item</li><li>Fourth item</li></ol>
<ul><li>Bullet item</li></ul>
<div class="counted">Counted by CSS</div>
<table><tr><td>Case</td><td>Outcome</td></tr></table>
<p aria-hidden="true">Hidden instructions for readers</p>
<p style="display:none">Not shown at all</p>
<p>Name <span style="font-size:0">secret words</span>visible</p>
<form role="search"><input type="search" placeholder="Search the work"><button>Search</button></form>
</body></html>`,
    "/works/structure",
  );
  const { page: frame, window } = await readWindow(
    page,
    readRequest({ type: "start" }),
  );
  const lines = window.text.split("\n");
  expect(lines).toEqual([
    "# Commentary on the notice rules",
    "#### § Scope of the rule",
    "12 The notice period runs from Vertragsschluss, not from dispatch.^3",
    "See the other work [L1] and top [L2].",
    "Second line of the block.",
    "3. Third item",
    "4. Fourth item",
    "- Bullet item",
    "Counted by CSS",
    "Case | Outcome",
    "Name visible",
    "Search",
  ]);
  expect(
    window.links.map(({ alternateName, href, name, number }) => ({
      alternateName,
      href,
      name,
      number,
    })),
  ).toEqual([
    {
      alternateName: "Opens the other work",
      href: {
        type: BROWSER_CONTROL_TARGET_METADATA.present,
        value: `${ORIGIN}/works/other#part-2`,
      },
      name: "the other work",
      number: 1,
    },
    {
      alternateName: "t",
      href: {
        type: BROWSER_CONTROL_TARGET_METADATA.present,
        value: `${ORIGIN}/works/structure#top`,
      },
      name: "top",
      number: 2,
    },
  ]);
  expect(window.hasBefore).toBe(false);
  expect(window.hasAfter).toBe(false);
  // Controls inside the window are listed with it, not again as the page's.
  expect(window.controls.map(({ name, role }) => ({ name, role }))).toEqual([
    { name: "Search the work", role: "searchbox" },
    { name: "Search", role: "button" },
  ]);
  expect(frame.pageControls).toEqual([]);
  expect(frame.facts).toEqual({
    canonicalUrl: `${ORIGIN}/works/structure`,
    language: "en",
    meta: [
      { name: "citation_title", value: "Structure fixture" },
      { name: "author", value: "Example Author" },
    ],
  });

  const { found: headings } = await find(page, {
    after: { type: "start" },
    headingChars: BROWSER_CONTROL_LIMITS.headingChars,
    maxResults: BROWSER_CONTROL_LIMITS.headings,
    query: "",
    type: "headings",
  });
  expect(headings).toMatchObject({
    headings: [
      { level: 1, text: "Commentary on the notice rules" },
      { level: 4, text: "Scope of the rule" },
    ],
    type: "headings",
  });
});

/** One window read, anywhere in the long document, takes less than this. */
const READ_BOUND_MS = 1500;
/** One find over the whole long document takes less than this. */
const FIND_BOUND_MS = 3000;
const SECTIONS = 1000;
const PARAGRAPHS = 10;
const FILLER =
  "the court held that the period for giving notice is counted from the day the letter reached the other party and not from the day it was sent, which the parties had agreed in the framework contract and confirmed in their later correspondence about the renewal of the lease, the deposit and the costs of the proceedings before the first instance court";

const headingLine = (section: number) =>
  `#### Section ${String(section)}: scope and effect`;
const paragraphLine = (section: number, paragraph: number) =>
  `${String(paragraph)} Paragraph ${String(section)}.${String(paragraph)}: ${
    section === 700 && paragraph === 4
      ? "Zuständigkeitsprüfung des Gerichts, "
      : ""
  }${FILLER}, see section ${String((section % SECTIONS) + 1)} and the Vertrag.^${String(paragraph)}`;

/** The document's text as the reader should return it, block by block. */
const EXPECTED_LINES = Array.from({ length: SECTIONS }, (_, index) => {
  const section = index + 1;
  return [
    headingLine(section),
    ...Array.from({ length: PARAGRAPHS }, (_unused, paragraph) =>
      paragraphLine(section, paragraph + 1),
    ),
  ];
}).flat();

const longDocument = () => {
  const sections = Array.from({ length: SECTIONS }, (_, index) => {
    const section = index + 1;
    const paragraphs = Array.from(
      { length: PARAGRAPHS },
      (_unused, paragraph) => {
        const number = paragraph + 1;
        const special =
          section === 700 && number === 4
            ? "Zust&auml;ndigkeitspr&uuml;fung des Gerichts, "
            : "";
        return `<div class="para"><span class="rn" aria-hidden="true">${String(number)}</span> Paragraph ${String(section)}.${String(number)}: ${special}${FILLER}<span style="display:none">HIDDEN-${String(section)}</span>, see <a href="#s-${String((section % SECTIONS) + 1)}">section ${String((section % SECTIONS) + 1)}</a> and the Ver<em>trag</em>.<sup>${String(number)}</sup></div>`;
      },
    ).join("");
    return `<div class="section" id="s-${String(section)}"><div class="sub">Section ${String(section)}: scope and effect</div>${paragraphs}</div>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><title>Long document</title>
<style>
  body { margin: 0; font: 16px/1.4 sans-serif; }
  header { position: fixed; top: 0; left: 0; right: 0; height: 60px; background: #fff; }
  main { padding-top: 70px; }
  .section { scroll-margin-top: 70px; }
  .sub { font-weight: 700; }
  .rn { float: left; width: 2em; }
</style></head><body>
<header><input type="search" placeholder="Find section or text"><button>Search</button></header>
<main>${sections}</main>
</body></html>`;
};

test("reads, pages and finds through a long document within bounds", async ({
  page,
}) => {
  const html = longDocument();
  await serve(page, html, "/works/long#s-500");
  const size = await page.evaluate(() => ({
    chars: (document.body.textContent ?? "").length,
    elements: document.querySelectorAll("*").length,
  }));
  expect(size.elements).toBeGreaterThanOrEqual(60_000);
  expect(size.chars).toBeGreaterThanOrEqual(4_000_000);

  // The default read starts at the section the address points to.
  const first = await readWindow(page, readRequest({ type: "viewport" }));
  const firstLines = first.window.text.split("\n").map(withoutLinkMarks);
  expect(firstLines.at(0)).toBe(headingLine(500));
  expect(first.window.text.length).toBeLessThanOrEqual(
    BROWSER_CONTROL_LIMITS.pageTextChars,
  );
  expect(first.window.hasBefore).toBe(true);
  expect(first.window.fromPercent).toBeGreaterThan(40);
  expect(first.window.fromPercent).toBeLessThan(60);
  // Each link the text marks is listed with its address.
  const marked = [...first.window.text.matchAll(/\[L(\d+)\]/gu)].map(
    ([, number]) => Number(number),
  );
  expect(marked.length).toBeGreaterThan(0);
  expect(first.window.links.map(({ number }) => number)).toEqual(marked);
  expect(first.window.links.at(0)).toMatchObject({
    href: {
      type: BROWSER_CONTROL_TARGET_METADATA.present,
      value: `${ORIGIN}/works/long#s-501`,
    },
    name: "section 501",
  });

  // Paging forward returns consecutive blocks: no gap, no repeat.
  const startIndex = EXPECTED_LINES.indexOf(headingLine(500));
  const collected = [...firstLines];
  let position: ReaderPosition = first.window.end;
  const forwardTimes: number[] = [first.elapsed];
  const windows = [first.window];
  for (let step = 0; step < 4; step += 1) {
    const next = await readWindow(page, readRequest(position));
    forwardTimes.push(next.elapsed);
    windows.push(next.window);
    collected.push(...next.window.text.split("\n").map(withoutLinkMarks));
    position = next.window.end;
  }
  expect(collected).toEqual(
    EXPECTED_LINES.slice(startIndex, startIndex + collected.length),
  );

  // Reading back from a window's start returns the blocks right before it.
  const third = windows[2];
  if (third === undefined) {
    throw new TypeError("No third window.");
  }
  const back = await readWindow(page, readRequest(third.start, "backward"));
  const backLines = back.window.text.split("\n").map(withoutLinkMarks);
  const thirdStart = EXPECTED_LINES.indexOf(
    withoutLinkMarks(third.text.split("\n").at(0) ?? ""),
  );
  expect(backLines).toEqual(
    EXPECTED_LINES.slice(thirdStart - backLines.length, thirdStart),
  );
  expect(back.window.hasAfter).toBe(true);

  // Find: case and diacritics ignored, any spacing, hidden text never found.
  const unique = await find(page, {
    after: { type: "start" },
    countLimit: BROWSER_CONTROL_LIMITS.findCountLimit,
    maxResults: BROWSER_CONTROL_LIMITS.findMatches,
    query: "zustandigkeitsprufung   DES",
    snippetChars: BROWSER_CONTROL_LIMITS.findSnippetChars,
    type: "text",
  });
  if (unique.found.type !== "text") {
    throw new TypeError("Expected text matches.");
  }
  expect(unique.found.total).toBe(1);
  expect(unique.found.matches.at(0)?.snippet).toContain(
    "Zuständigkeitsprüfung des Gerichts",
  );
  const matchPosition = unique.found.matches.at(0)?.position;
  if (matchPosition === undefined) {
    throw new TypeError("No match position.");
  }
  const atMatch = await readWindow(page, readRequest(matchPosition));
  expect(withoutLinkMarks(atMatch.window.text.split("\n").at(0) ?? "")).toBe(
    paragraphLine(700, 4),
  );

  const hidden = await find(page, {
    after: { type: "start" },
    countLimit: BROWSER_CONTROL_LIMITS.findCountLimit,
    maxResults: BROWSER_CONTROL_LIMITS.findMatches,
    query: "HIDDEN-500",
    snippetChars: BROWSER_CONTROL_LIMITS.findSnippetChars,
    type: "text",
  });
  expect(hidden.found).toMatchObject({ matches: [], total: 0 });

  const common = await find(page, {
    after: { type: "start" },
    countLimit: BROWSER_CONTROL_LIMITS.findCountLimit,
    maxResults: BROWSER_CONTROL_LIMITS.findMatches,
    query: "vertrag",
    snippetChars: BROWSER_CONTROL_LIMITS.findSnippetChars,
    type: "text",
  });
  expect(common.found).toMatchObject({
    total: BROWSER_CONTROL_LIMITS.findCountLimit,
    totalCapped: true,
    type: "text",
  });

  // The outline pages through every heading, in order.
  const outline = await find(page, {
    after: { type: "start" },
    headingChars: BROWSER_CONTROL_LIMITS.headingChars,
    maxResults: BROWSER_CONTROL_LIMITS.headings,
    query: "",
    type: "headings",
  });
  if (outline.found.type !== "headings" || outline.found.more === undefined) {
    throw new TypeError("Expected a first page of headings.");
  }
  const outlineNext = await find(page, {
    after: outline.found.more,
    headingChars: BROWSER_CONTROL_LIMITS.headingChars,
    maxResults: BROWSER_CONTROL_LIMITS.headings,
    query: "",
    type: "headings",
  });
  if (outlineNext.found.type !== "headings") {
    throw new TypeError("Expected headings.");
  }
  expect(
    [...outline.found.headings, ...outlineNext.found.headings].map(
      ({ level, text }) => `${"#".repeat(level)} ${text}`,
    ),
  ).toEqual(
    Array.from({ length: BROWSER_CONTROL_LIMITS.headings * 2 }, (_, index) =>
      headingLine(index + 1),
    ),
  );
  const filtered = await find(page, {
    after: { type: "start" },
    headingChars: BROWSER_CONTROL_LIMITS.headingChars,
    maxResults: BROWSER_CONTROL_LIMITS.headings,
    query: "section 77:",
    type: "headings",
  });
  expect(filtered.found).toMatchObject({
    headings: [{ level: 4, text: "Section 77: scope and effect" }],
  });

  // The stated bounds: one window and one whole-document find.
  const slowestRead = Math.max(...forwardTimes, back.elapsed);
  test.info().annotations.push({
    description: `${String(size.elements)} elements, ${String(size.chars)} chars; window reads ${forwardTimes
      .map((time) => `${time.toFixed(0)} ms`)
      .join(
        ", ",
      )}; backward read ${back.elapsed.toFixed(0)} ms; find over the whole document ${unique.elapsed.toFixed(0)} ms; capped find ${common.elapsed.toFixed(0)} ms; first outline page ${outline.elapsed.toFixed(0)} ms`,
    type: "reader timings",
  });
  expect(slowestRead).toBeLessThan(READ_BOUND_MS);
  expect(unique.elapsed).toBeLessThan(FIND_BOUND_MS);
});

test("a position into changed content is refused, not read elsewhere", async ({
  page,
}) => {
  await serve(page, longDocument(), "/works/long#s-10");
  const first = await readWindow(page, readRequest({ type: "viewport" }));
  const { end } = first.window;
  if (end.type !== "node") {
    throw new TypeError("Expected a position inside the document.");
  }
  // The page drops its first sections: the same path now leads to another
  // paragraph, with the same margin number.
  await page.evaluate(() => {
    for (const section of [...document.querySelectorAll(".section")].slice(
      0,
      20,
    )) {
      section.remove();
    }
  });
  const { result } = await read(page, readRequest(end));
  expect(result).toEqual({ refused: "stale-cursor" });
  // The same document unchanged still reads from the position.
  await page.reload();
  const again = await readWindow(page, readRequest({ type: "viewport" }));
  expect(again.window.end).toEqual(end);
  const { result: resumed } = await read(page, readRequest(end));
  expect(resumed).toMatchObject({ window: { hasBefore: true } });
});
