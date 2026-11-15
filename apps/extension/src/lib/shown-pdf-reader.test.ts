import { afterEach, describe, expect, test } from "bun:test";

import { readShownPdf, takeShownPdfReaderRequest } from "./shown-pdf-reader";

const PDF_BYTES = "%PDF-1.7\nfixture\n%%EOF\n";

const EXTENSION_ID = "stella-extension";
const WORKER = {
  id: EXTENSION_ID,
  origin: `chrome-extension://${EXTENSION_ID}`,
};

const readRequest = (url: string) =>
  ({
    maxBytes: 1024,
    target: "stella-shown-pdf-reader",
    type: "read",
    url,
  }) as const;

/** A tab as Chrome describes a content script's. */
const pageTab: chrome.tabs.Tab = {
  active: true,
  autoDiscardable: true,
  discarded: false,
  frozen: false,
  groupId: -1,
  highlighted: true,
  id: 3,
  incognito: false,
  index: 0,
  lastAccessed: 0,
  pinned: false,
  selected: true,
  url: "https://fixture-library.test/decisions/42",
  windowId: 1,
};

describe("the offscreen reader's requests", () => {
  test("it takes a read of a public HTTPS address from the extension's worker", () => {
    const request = readRequest("https://fixture-library.test/decisions/42");
    expect(takeShownPdfReaderRequest(request, WORKER, EXTENSION_ID)).toEqual(
      request,
    );
    const release = {
      downloadUrl: `blob:chrome-extension://${EXTENSION_ID}/1`,
      target: "stella-shown-pdf-reader",
      type: "release",
    } as const;
    expect(takeShownPdfReaderRequest(release, WORKER, EXTENSION_ID)).toEqual(
      release,
    );
  });

  test("it refuses a content script, a page's origin and another extension", () => {
    const request = readRequest("https://fixture-library.test/decisions/42");
    for (const sender of [
      {
        id: EXTENSION_ID,
        origin: "https://fixture-library.test",
        tab: pageTab,
      },
      { id: EXTENSION_ID, tab: pageTab },
      { id: EXTENSION_ID, origin: "https://fixture-library.test" },
      {
        id: "another-extension",
        origin: "chrome-extension://another-extension",
      },
    ]) {
      expect(
        takeShownPdfReaderRequest(request, sender, EXTENSION_ID),
      ).toBeNull();
    }
  });

  test("it never reads an address outside the public web, whoever asks", () => {
    for (const url of [
      "http://fixture-library.test/decisions/42",
      "https://192.168.1.20/files/42.pdf",
      "https://127.0.0.1/files/42.pdf",
      "https://intranet/files/42.pdf",
      "file:///etc/hosts",
    ]) {
      expect(
        takeShownPdfReaderRequest(readRequest(url), WORKER, EXTENSION_ID),
      ).toBeNull();
    }
  });
});

type Served = {
  origin: string;
  /** Every path asked for, in order. */
  requests: string[];
  stop: () => Promise<void>;
};

const servers: Served[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ stop }) => await stop()));
});

/** A local server answering each path with `answer`, recording every request. */
const serve = (answer: (path: string) => Response): Served => {
  const requests: string[] = [];
  const server = Bun.serve({
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      requests.push(pathname);
      return answer(pathname);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const served = {
    origin: `http://127.0.0.1:${String(server.port)}`,
    requests,
    stop: async () => {
      await server.stop(true);
    },
  };
  servers.push(served);
  return served;
};

const pdf = () =>
  new Response(PDF_BYTES, {
    headers: { "cache-control": "no-store", "content-type": "application/pdf" },
  });

describe("reading a shown PDF for its save", () => {
  test("a redirect is never followed: its target is never asked for", async () => {
    // Stands in for a private host the redirect points at.
    const target = serve(() => pdf());
    const site = serve(
      () =>
        new Response(null, {
          headers: { location: `${target.origin}/internal.pdf` },
          status: 302,
        }),
    );

    expect(await readShownPdf(`${site.origin}/decisions/42`, 1024)).toEqual({
      reason: "redirected",
      type: "refused",
    });
    expect(site.requests).toEqual(["/decisions/42"]);
    expect(target.requests).toEqual([]);
  });

  test("a redirect within the same site is not followed either", async () => {
    const site = serve((path) =>
      path === "/decisions/42"
        ? new Response(null, {
            headers: { location: "/files/42.pdf" },
            status: 307,
          })
        : pdf(),
    );

    expect(await readShownPdf(`${site.origin}/decisions/42`, 1024)).toEqual({
      reason: "redirected",
      type: "refused",
    });
    expect(site.requests).toEqual(["/decisions/42"]);
  });

  test("the PDF is read once and kept as a blob address of its bytes", async () => {
    const site = serve(() => pdf());
    const address = `${site.origin}/decisions/42`;

    const read = await readShownPdf(address, 1024);

    expect(read).toMatchObject({
      bytes: PDF_BYTES.length,
      fetchedUrl: address,
      type: "read",
    });
    expect(site.requests).toEqual(["/decisions/42"]);
    if (read.type !== "read") {
      throw new TypeError("The read was refused");
    }
    expect(read.downloadUrl.startsWith("blob:")).toBe(true);
    expect(await (await fetch(read.downloadUrl)).text()).toBe(PDF_BYTES);
    URL.revokeObjectURL(read.downloadUrl);
  });

  test("a PDF larger than the limit is refused", async () => {
    const site = serve(() => pdf());

    expect(
      await readShownPdf(`${site.origin}/decisions/42`, PDF_BYTES.length - 1),
    ).toEqual({ reason: "too-large", type: "refused" });
  });

  test("an error answer or an address nothing answers at is interrupted", async () => {
    const site = serve(() => new Response("gone", { status: 410 }));
    expect(await readShownPdf(`${site.origin}/decisions/42`, 1024)).toEqual({
      reason: "interrupted",
      type: "refused",
    });

    const closed = serve(() => pdf());
    await closed.stop();
    expect(await readShownPdf(`${closed.origin}/decisions/42`, 1024)).toEqual({
      reason: "interrupted",
      type: "refused",
    });
  });
});
