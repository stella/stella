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
 * the reader's structure, what it keeps out, how much of the page one call
 * touches, and paging that neither skips nor repeats a block.
 */

const ORIGIN = "https://reader.test";

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
  maxChars: BROWSER_CONTROL_LIMITS.pageTextChars,
  maxControls: BROWSER_CONTROL_LIMITS.elements,
  maxLinks: BROWSER_CONTROL_LIMITS.elements,
  position,
});

const FROM_START = { type: "start" } as const;

const textFind = (
  query: string,
  after: FindRequest["after"] = FROM_START,
): FindRequest => ({
  after,
  countLimit: BROWSER_CONTROL_LIMITS.findCountLimit,
  maxResults: BROWSER_CONTROL_LIMITS.findMatches,
  query,
  snippetChars: BROWSER_CONTROL_LIMITS.findSnippetChars,
  type: "text",
});

const headingsFind = (
  query = "",
  after: FindRequest["after"] = FROM_START,
): FindRequest => ({
  after,
  headingChars: BROWSER_CONTROL_LIMITS.headingChars,
  maxResults: BROWSER_CONTROL_LIMITS.headings,
  query,
  type: "headings",
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

/**
 * Counts every computed-style and layout read the page makes: how much of
 * the page one call touched, which stays the same on any machine.
 */
const countLayoutReads = async (page: Page) => {
  await page.evaluate(() => {
    const counts = { calls: 0 };
    Reflect.set(window, "stellaLayoutReads", counts);
    const computedStyle = window.getComputedStyle.bind(window);
    window.getComputedStyle = (element, pseudo) => {
      counts.calls += 1;
      return computedStyle(element, pseudo);
    };
    for (const method of ["getBoundingClientRect", "getClientRects"] as const) {
      const original = Element.prototype[method];
      Object.defineProperty(Element.prototype, method, {
        configurable: true,
        value(this: Element) {
          counts.calls += 1;
          return Reflect.apply(original, this, []);
        },
      });
    }
  });
};

const layoutReadsSince = async (page: Page, run: () => Promise<unknown>) => {
  await page.evaluate(() => {
    Reflect.set(Reflect.get(window, "stellaLayoutReads"), "calls", 0);
  });
  await run();
  return await page.evaluate((): number => {
    const calls: unknown = Reflect.get(
      Reflect.get(window, "stellaLayoutReads"),
      "calls",
    );
    return typeof calls === "number" ? calls : -1;
  });
};

/** Runs one read in the page, as the extension injects it. */
const read = async (page: Page, request: ReadRequest | undefined) => {
  const operation: PageOperation = {
    ...base,
    facts: true,
    idPrefix: "",
    kind: "snapshot",
    pageControls: BROWSER_CONTROL_LIMITS.elements,
    purpose: SNAPSHOT_PURPOSE.read,
    purposes: SNAPSHOT_PURPOSE,
    ...(request === undefined ? {} : { read: request }),
  };
  const result: unknown = await page.evaluate(pageScript, operation);
  return result;
};

const readWindow = async (page: Page, request: ReadRequest) => {
  const parsed = v.parse(frameReadSchema, await read(page, request));
  const { window } = parsed;
  if (window === undefined) {
    throw new TypeError("The read returned no window.");
  }
  return { page: parsed, window };
};

const find = async (page: Page, request: FindRequest) => {
  const operation: PageOperation = { ...base, find: request, kind: "find" };
  const result: unknown = await page.evaluate(pageScript, operation);
  return v.parse(frameFoundSchema, result).found;
};

const textMatches = async (page: Page, query: string) => {
  const found = await find(page, textFind(query));
  if (found.type !== "text") {
    throw new TypeError("Expected text matches.");
  }
  return found;
};

const withoutLinkMarks = (line: string) =>
  line.replaceAll(/ ?\[L[\d.]+\]/gu, "");

test("keeps block structure, headings, markers and links", async ({ page }) => {
  await serve(
    page,
    `<!doctype html><html lang="en"><head><title>Structure</title>
<link rel="canonical" href="${ORIGIN}/works/structure">
<meta name="citation_title" content="Structure fixture">
<meta name="author" content="Example Author">
<meta name="description" content="Text the page never shows">
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
<h2><div>Wrapped heading</div></h2>
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
  expect(window.text.split("\n")).toEqual([
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
    "## Wrapped heading",
    "Name visible",
    "Search",
  ]);
  // A link is named by its visible words; its aria-label or title, a
  // short label of the same link, is kept beside them.
  expect(
    window.links.map(({ alternateName, href, id, name }) => ({
      alternateName,
      href,
      id,
      name,
    })),
  ).toEqual([
    {
      alternateName: "Opens the other work",
      href: {
        type: BROWSER_CONTROL_TARGET_METADATA.present,
        value: `${ORIGIN}/works/other#part-2`,
      },
      id: "L1",
      name: "the other work",
    },
    {
      alternateName: "t",
      href: {
        type: BROWSER_CONTROL_TARGET_METADATA.present,
        value: `${ORIGIN}/works/structure#top`,
      },
      id: "L2",
      name: "top",
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
  // Only what identifies the work: no description the page never shows.
  expect(frame.facts).toEqual({
    canonicalUrl: `${ORIGIN}/works/structure`,
    language: "en",
    meta: [
      { name: "citation_title", value: "Structure fixture" },
      { name: "author", value: "Example Author" },
    ],
  });

  // The outline lists each heading once, as the text shows it.
  expect(await find(page, headingsFind())).toMatchObject({
    headings: [
      { level: 1, text: "Commentary on the notice rules" },
      { level: 4, text: "§ Scope of the rule" },
      { level: 2, text: "Wrapped heading" },
    ],
    type: "headings",
  });

  // Find searches the printed text: markers, words split by inline tags,
  // and nothing hidden.
  expect(await textMatches(page, "12 the notice")).toMatchObject({ total: 1 });
  expect(await textMatches(page, "vertragsschluss")).toMatchObject({
    total: 1,
  });
  expect(await textMatches(page, "secret words")).toMatchObject({ total: 0 });
  expect(await textMatches(page, "hidden instructions")).toMatchObject({
    total: 0,
  });
});

test("keeps generated and hidden text out of reads and finds", async ({
  page,
}) => {
  await serve(
    page,
    `<!doctype html><html lang="en"><head><title>Hidden</title>
<style>
  .size::after { content: " HIDDEN-SIZE"; font-size: 0; }
  .color::after { content: " HIDDEN-COLOR"; color: transparent; }
  .shown::after { content: " HIDDEN-VISIBILITY"; visibility: hidden; }
  .faded::after { content: " HIDDEN-OPACITY"; opacity: 0; }
  .away::after { content: " HIDDEN-AWAY"; position: absolute; left: -9999px; }
  .clipped::after { content: " HIDDEN-CLIP"; position: relative; clip-path: circle(0); }
  .marker::after { content: " HIDDEN-MARKER"; }
  .long::before { content: "ABCDEFGHIJKLMNOPQRSTUVWXYZ "; }
  .icon::before { content: "\\e001"; }
</style></head><body>
<p class="size">Size</p>
<p class="color">Colour</p>
<p class="shown">Visibility</p>
<p class="faded">Opacity</p>
<p class="away">Away</p>
<p class="clipped">Clipped</p>
<p><span aria-hidden="true" class="marker">7</span> Marked paragraph</p>
<p class="long">Long generated</p>
<p><span class="icon"></span>Icon text</p>
<p>ign<span style="display:none">XYZ</span>ore this</p>
<shadow-note></shadow-note>
<script>
  customElements.define("shadow-note", class extends HTMLElement {
    connectedCallback() {
      this.attachShadow({ mode: "open" }).innerHTML = "<p>Shadow words here</p>";
    }
  });
</script>
</body></html>`,
    "/works/hidden",
  );
  const { window } = await readWindow(page, readRequest({ type: "start" }));
  const lines = window.text.split("\n");
  expect(lines.slice(0, 10)).toEqual([
    "Size",
    "Colour",
    "Visibility",
    "Opacity",
    "Away",
    "Clipped",
    "7 Marked paragraph",
    "ABCDEFGHIJKLMNOPLong generated",
    "Icon text",
    "ignore this",
  ]);
  expect(window.text).not.toContain("HIDDEN");
  expect(window.text).toContain("Shadow words here");

  for (const query of ["hidden", "ignxyzore", "xyz"]) {
    expect(await textMatches(page, query)).toMatchObject({
      matches: [],
      total: 0,
    });
  }
  // What the reader prints is what find matches, shadow text included.
  const shadow = await textMatches(page, "SHADOW   words");
  expect(shadow.total).toBe(1);
  expect(shadow.matches.at(0)?.snippet).toContain("Shadow words here");
  expect(await textMatches(page, "ignore this")).toMatchObject({ total: 1 });
  expect(await textMatches(page, "7 marked")).toMatchObject({ total: 1 });
});

test("a link to a section inside hidden content starts no read there", async ({
  page,
}) => {
  const html = `<!doctype html><html lang="en"><head><title>Anchors</title></head><body>
<div style="opacity: 0; position: absolute; top: 0"><p id="faded">INJECTED-FADED</p><p>INJECTED-AFTER</p></div>
<div aria-hidden="true"><p id="unheard">INJECTED-ARIA</p></div>
<p id="shown">Visible section</p>
<p>Visible text after it</p>
</body></html>`;
  await page.route(`${ORIGIN}/**`, async (route) => {
    await route.fulfill({
      body: html,
      contentType: "text/html; charset=utf-8",
    });
  });
  for (const fragment of ["faded", "unheard"]) {
    await page.goto(`${ORIGIN}/works/anchors#${fragment}`);
    const { window } = await readWindow(
      page,
      readRequest({ type: "viewport" }),
    );
    expect(window.text).not.toContain("INJECTED");
    expect(window.text).toContain("Visible section");
  }
  await page.goto(`${ORIGIN}/works/anchors#shown`);
  const { window } = await readWindow(page, readRequest({ type: "viewport" }));
  expect(window.text.split("\n").at(0)).toBe("Visible section");
});

/** One block far longer than a window, sentences numbered to place a cut. */
const LONG_BLOCK = Array.from(
  { length: 6000 },
  (_, index) => `Sentence ${String(index + 1)} of the long block.`,
).join(" ");

test("reads a block longer than a window forward and backward without a gap", async ({
  page,
}) => {
  await serve(
    page,
    `<!doctype html><html lang="en"><head><title>Long block</title></head><body>
<h1>Long block</h1><p>${LONG_BLOCK}</p><p>After the block.</p>
</body></html>`,
    "/works/block",
  );
  const windows = [
    (await readWindow(page, readRequest({ type: "start" }))).window,
  ];
  for (let step = 0; step < 3; step += 1) {
    const last = windows.at(-1);
    if (last === undefined || !last.hasAfter) {
      break;
    }
    windows.push((await readWindow(page, readRequest(last.end))).window);
  }
  const [first, second, third] = windows;
  if (first === undefined || second === undefined || third === undefined) {
    throw new TypeError("Expected three windows.");
  }
  // Forward: cut at spaces, every word once.
  const firstPart = first.text.split("\n").at(1) ?? "";
  expect(
    `${firstPart} ${second.text} ${third.text.split("\n").at(0) ?? ""}`,
  ).toBe(
    LONG_BLOCK.slice(
      0,
      LONG_BLOCK.indexOf(third.text.split("\n").at(0) ?? "") +
        (third.text.split("\n").at(0) ?? "").length,
    ),
  );
  // Backward from the third window: the words right before it.
  const back = (await readWindow(page, readRequest(third.start, "backward")))
    .window;
  const thirdOffset = LONG_BLOCK.indexOf(third.text.split("\n").at(0) ?? "");
  expect(back.text.length).toBeGreaterThan(1000);
  expect(
    LONG_BLOCK.slice(0, thirdOffset).trimEnd().endsWith(back.text.trimEnd()),
  ).toBe(true);
  expect(back.hasBefore).toBe(true);
  expect(back.hasAfter).toBe(true);
  expect(back.start).toMatchObject({ type: "node" });
});

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

/**
 * Style and layout reads one window may make per line it returns: a line
 * here is one paragraph of six elements, each read for its own style, its
 * boxes and its `::before` and `::after`.
 */
const LAYOUT_READS_PER_LINE = 60;

test("reads, pages and finds through a long document, touching only what it reads", async ({
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
  await countLayoutReads(page);

  // The default read starts at the section the address points to.
  const windows: Awaited<ReturnType<typeof readWindow>>["window"][] = [];
  const reads: number[] = [];
  reads.push(
    await layoutReadsSince(page, async () => {
      await test.step("read the window at the section in view", async () => {
        windows.push(
          (await readWindow(page, readRequest({ type: "viewport" }))).window,
        );
      });
    }),
  );
  const first = windows[0];
  if (first === undefined) {
    throw new TypeError("No first window.");
  }
  const firstLines = first.text.split("\n").map(withoutLinkMarks);
  expect(firstLines.at(0)).toBe(headingLine(500));
  expect(first.text.length).toBeLessThanOrEqual(
    BROWSER_CONTROL_LIMITS.pageTextChars,
  );
  expect(first.hasBefore).toBe(true);
  expect(first.fromPercent).toBeGreaterThan(40);
  expect(first.fromPercent).toBeLessThan(60);
  // Each link the text marks is listed with its address.
  const marked = [...first.text.matchAll(/\[(L\d+)\]/gu)].map(([, id]) => id);
  expect(marked.length).toBeGreaterThan(0);
  expect(first.links.map(({ id }) => id)).toEqual(marked);
  expect(first.links.at(0)).toMatchObject({
    href: {
      type: BROWSER_CONTROL_TARGET_METADATA.present,
      value: `${ORIGIN}/works/long#s-501`,
    },
    name: "section 501",
  });

  // Paging forward returns consecutive blocks: no gap, no repeat.
  const startIndex = EXPECTED_LINES.indexOf(headingLine(500));
  const collected = [...firstLines];
  let position: ReaderPosition = first.end;
  for (let step = 0; step < 4; step += 1) {
    const from = position;
    const name = `read the next window (${String(step + 1)})`;
    reads.push(
      await layoutReadsSince(page, async () => {
        await test.step(name, async () => {
          windows.push((await readWindow(page, readRequest(from))).window);
        });
      }),
    );
    const next = windows.at(-1);
    if (next === undefined) {
      throw new TypeError("No window.");
    }
    collected.push(...next.text.split("\n").map(withoutLinkMarks));
    position = next.end;
  }
  expect(collected).toEqual(
    EXPECTED_LINES.slice(startIndex, startIndex + collected.length),
  );

  // A link keeps its id whatever window shows it again.
  const again = (await readWindow(page, readRequest(first.start))).window;
  expect(again.links.map(({ href, id }) => [id, href])).toEqual(
    first.links.map(({ href, id }) => [id, href]),
  );
  const firstIds = new Set(first.links.map(({ id }) => id));
  expect(windows[1]?.links.some(({ id }) => firstIds.has(id))).toBe(false);

  // Reading back from a window's start returns the blocks right before it.
  const third = windows[2];
  if (third === undefined) {
    throw new TypeError("No third window.");
  }
  const back = (await readWindow(page, readRequest(third.start, "backward")))
    .window;
  const backLines = back.text.split("\n").map(withoutLinkMarks);
  const thirdStart = EXPECTED_LINES.indexOf(
    withoutLinkMarks(third.text.split("\n").at(0) ?? ""),
  );
  expect(backLines).toEqual(
    EXPECTED_LINES.slice(thirdStart - backLines.length, thirdStart),
  );
  expect(back.hasAfter).toBe(true);

  // A window touches what it reads, not the page.
  for (const [index, window] of windows.entries()) {
    const lines = window.text.split("\n").length;
    expect(reads[index]).toBeLessThan(LAYOUT_READS_PER_LINE * lines);
    expect(reads[index]).toBeLessThan(size.elements / 10);
  }

  // Find: case and diacritics ignored, any spacing, hidden text never
  // found; it reads the blocks the query's words are in, not the page.
  const found: Awaited<ReturnType<typeof textMatches>>[] = [];
  const uniqueReads = await layoutReadsSince(page, async () => {
    await test.step("find one phrase in the whole document", async () => {
      found.push(await textMatches(page, "zustandigkeitsprufung   DES"));
    });
  });
  const unique = found[0];
  if (unique === undefined) {
    throw new TypeError("No find result.");
  }
  expect(unique.total).toBe(1);
  expect(uniqueReads).toBeLessThan(LAYOUT_READS_PER_LINE * 10);
  expect(unique.matches.at(0)?.snippet).toContain(
    "Zuständigkeitsprüfung des Gerichts",
  );
  const matchPosition = unique.matches.at(0)?.position;
  if (matchPosition === undefined) {
    throw new TypeError("No match position.");
  }
  const atMatch = (await readWindow(page, readRequest(matchPosition))).window;
  expect(withoutLinkMarks(atMatch.text.split("\n").at(0) ?? "")).toBe(
    paragraphLine(700, 4),
  );

  expect(await textMatches(page, "HIDDEN-500")).toMatchObject({
    matches: [],
    total: 0,
  });

  const common = await test.step("find a word on every paragraph", async () =>
    await textMatches(page, "vertrag"));
  expect(common).toMatchObject({
    total: BROWSER_CONTROL_LIMITS.findCountLimit,
    totalCapped: true,
  });
  // The next page of results goes on after the last one returned.
  const resumed = await find(
    page,
    textFind("vertrag", common.last ?? { type: "start" }),
  );
  if (resumed.type !== "text") {
    throw new TypeError("Expected text matches.");
  }
  // Section 1's ten paragraphs filled the first page; the next starts in
  // section 2, whose first paragraph links to section 3.
  expect(common.matches.at(-1)?.snippet).toContain(
    "see section 2 and the Vertrag",
  );
  expect(resumed.matches.at(0)?.snippet).toContain(
    "see section 3 and the Vertrag",
  );

  // The outline pages through every heading, in order.
  const outline = await test.step("list the first page of headings", async () =>
    await find(page, headingsFind()));
  if (outline.type !== "headings" || outline.more === undefined) {
    throw new TypeError("Expected a first page of headings.");
  }
  const outlineNext = await find(page, headingsFind("", outline.more));
  if (outlineNext.type !== "headings") {
    throw new TypeError("Expected headings.");
  }
  expect(
    [...outline.headings, ...outlineNext.headings].map(
      ({ level, text }) => `${"#".repeat(level)} ${text}`,
    ),
  ).toEqual(
    Array.from({ length: BROWSER_CONTROL_LIMITS.headings * 2 }, (_, index) =>
      headingLine(index + 1),
    ),
  );
  expect(await find(page, headingsFind("section 77:"))).toMatchObject({
    headings: [{ level: 4, text: "Section 77: scope and effect" }],
  });

  test.info().annotations.push({
    description: `${String(size.elements)} elements, ${String(size.chars)} chars; style and layout reads per window ${reads.join(", ")}; per whole-document find of one phrase ${String(uniqueReads)}. Step durations are in the report.`,
    type: "reader cost",
  });
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
  expect(await read(page, readRequest(end))).toEqual({
    refused: "stale-cursor",
  });
  // The same document unchanged still reads from the position.
  await page.reload();
  const again = await readWindow(page, readRequest({ type: "viewport" }));
  expect(again.window.end).toEqual(end);
  expect(await read(page, readRequest(end))).toMatchObject({
    window: { hasBefore: true },
  });
});
