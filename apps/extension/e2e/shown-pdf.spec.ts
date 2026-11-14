import { expect, test } from "@playwright/test";

import {
  createCommandSender,
  elementNamed,
  launchExtensionHarness,
  openInNewControlledTab,
  successful,
  targetOf,
} from "./fixtures/harness";

/**
 * A PDF a research site shows in the tab, in Chrome's own viewer: the
 * read says so and returns no text. Under the web connection nothing is
 * saved; a stella desktop chat's save is covered by the unit tests, since
 * no native host runs here.
 */

const CONTROLLER_ID = "controller-shown-pdf";
const SITE_ORIGIN = "https://research.stella-test.example";
const PDF_PATH = "/decisions/42";

/** A one-page PDF; Chrome's viewer repairs the missing cross-reference table. */
const PDF_BODY = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
  ].join("\n"),
);

const SEARCH_PAGE = `<!doctype html><html><head><title>Decisions</title></head><body>
<h1>Decisions</h1>
<p><a href="${PDF_PATH}">Judgment 42</a></p>
</body></html>`;

type Harness = Awaited<ReturnType<typeof launchExtensionHarness>>;

/** The site serves its search page, and the PDF inline, with no attachment header. */
const routeSite = async ({ context }: Harness) => {
  await context.route(`${SITE_ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    await (pathname === PDF_PATH
      ? route.fulfill({ body: PDF_BODY, contentType: "application/pdf" })
      : route.fulfill({ body: SEARCH_PAGE, contentType: "text/html" }));
  });
};

const downloadCount = async ({ worker }: Harness) =>
  await worker.evaluate(async () => (await chrome.downloads.search({})).length);

test("a PDF shown in the tab reads as a PDF with no text, and the web connection saves nothing", async () => {
  // timeout: it launches Chrome with the extension and loads Chrome's PDF viewer twice.
  test.setTimeout(120_000);
  const harness = await launchExtensionHarness();
  await routeSite(harness);
  try {
    await harness.pair(CONTROLLER_ID);
    const { send } = createCommandSender(harness.stella, CONTROLLER_ID);

    // Opened directly.
    const opened = await openInNewControlledTab(
      harness,
      send,
      `${SITE_ORIGIN}${PDF_PATH}`,
    );
    expect(opened.document).toEqual({ type: "pdf" });
    expect(opened.text).toBe("");
    expect(opened.elements).toEqual([]);
    expect(opened.url).toBe(`${SITE_ORIGIN}${PDF_PATH}`);

    // Reached by a click on the site's link.
    const search = successful(
      await send({ action: "open", url: `${SITE_ORIGIN}/search` }),
    );
    expect(search.document).toBeUndefined();
    const clicked = successful(
      await send({
        action: "click",
        page: { revision: search.revision, url: search.url },
        target: targetOf(elementNamed(search.elements, "Judgment 42")),
      }),
    );
    expect(clicked.document).toEqual({ type: "pdf" });
    expect(clicked.text).toBe("");
    expect(clicked.url).toBe(`${SITE_ORIGIN}${PDF_PATH}`);

    expect(await downloadCount(harness)).toBe(0);
  } finally {
    await harness.close();
  }
});
