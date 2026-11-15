import { expect, test } from "@playwright/test";
import { createServer } from "node:http";

import {
  closeServer,
  createCommandSender,
  elementNamed,
  launchExtensionHarness,
  listen,
  openInNewControlledTab,
  successful,
  targetOf,
} from "./fixtures/harness";

/**
 * A PDF a research site shows in the tab, in Chrome's own viewer: the
 * read says so and returns no text. Under the web connection nothing is
 * saved. A stella desktop chat's save runs through the offscreen reader,
 * tested here in Chrome against local servers; the rest of the save is
 * covered by the unit tests, since no native host runs here.
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

    // The site's search page, in a tab chat controls.
    const first = await openInNewControlledTab(
      harness,
      send,
      `${SITE_ORIGIN}/search`,
    );
    expect(first.document).toBeUndefined();

    // Opened directly in that tab: `open` itself must read the PDF.
    const opened = successful(
      await send({ action: "open", url: `${SITE_ORIGIN}${PDF_PATH}` }),
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

type Answer = { body: string; headers: Record<string, string>; status: number };

/** A loopback server answering each path with `answer`, recording every path asked for. */
const startServer = async (answer: (path: string) => Answer) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    const { body, headers, status } = answer(path);
    response.writeHead(status, headers);
    response.end(body);
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${String(port)}`, requests, server };
};

const PDF_TEXT = "%PDF-1.4\n%%EOF\n";

test("the shown PDF reader in Chrome answers the worker and never reads an address outside the public web", async () => {
  // timeout: it launches Chrome with the extension and opens its offscreen document.
  test.setTimeout(120_000);
  // Stands in for a private host a redirect points at.
  const target = await startServer(() => ({
    body: PDF_TEXT,
    headers: { "content-type": "application/pdf" },
    status: 200,
  }));
  const site = await startServer((path) =>
    path === "/redirect"
      ? {
          body: "",
          headers: { location: `${target.origin}/internal.pdf` },
          status: 302,
        }
      : {
          body: PDF_TEXT,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/pdf",
          },
          status: 200,
        },
  );
  const harness = await launchExtensionHarness();
  try {
    const read = async (url: string): Promise<unknown> =>
      await harness.worker.evaluate(async (address) => {
        const open = await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
        });
        if (open.length === 0) {
          await chrome.offscreen.createDocument({
            justification: "Reads a shown PDF in the end-to-end test.",
            reasons: ["BLOBS"],
            url: "offscreen.html",
          });
        }
        // A message the reader leaves unanswered ends without a value, or
        // with Chrome's error that nothing answered.
        const answer: unknown = await chrome.runtime
          .sendMessage({
            maxBytes: 1024,
            target: "stella-shown-pdf-reader",
            type: "read",
            url: address,
          })
          // swallow-ok: an unanswered message rejects; the test asserts that outcome as "unanswered"
          .catch(() => undefined);
        return answer ?? "unanswered";
      }, url);

    // The worker is answered: this public address resolves nowhere here,
    // so the read reports it could not fetch it.
    expect(await read(`${SITE_ORIGIN}/decisions/42`)).toEqual({
      reason: "interrupted",
      type: "refused",
    });

    // A loopback address is never read, even when the worker asks, and
    // nothing is requested from it or from where it would redirect.
    expect(await read(`${site.origin}/redirect`)).toBe("unanswered");
    expect(await read(`${site.origin}/decisions/42`)).toBe("unanswered");
    expect(site.requests).toEqual([]);
    expect(target.requests).toEqual([]);
  } finally {
    await harness.close();
    await closeServer(site.server);
    await closeServer(target.server);
  }
});
