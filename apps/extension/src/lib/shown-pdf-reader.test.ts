import { afterEach, describe, expect, test } from "bun:test";

import {
  answerShownPdfRead,
  createOffscreenShownPdfReader,
  readShownPdf,
  type ShownPdfRead,
  takeShownPdfReaderRequest,
} from "./shown-pdf-reader";

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

/** The tab a content script's sender names. */
const pageTab = { id: 3, url: "https://fixture-library.test/decisions/42" };

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
      // A port Chrome names no sender for.
      undefined,
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

describe("the read's deadline", () => {
  test("a body that stalls ends as interrupted once the deadline passes", async () => {
    const sent = Promise.withResolvers<undefined>();
    const site = serve(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              // One chunk, then nothing more: the stream never ends.
              controller.enqueue(new TextEncoder().encode("%PDF-"));
              sent.resolve(undefined);
            },
          }),
          { headers: { "content-type": "application/pdf" } },
        ),
    );
    const deadline = new AbortController();

    const reading = readShownPdf(`${site.origin}/decisions/42`, 1024, {
      deadline: deadline.signal,
    });
    await sent.promise;
    deadline.abort();

    expect(await reading).toEqual({ reason: "interrupted", type: "refused" });
  });
});

describe("answering a read in the offscreen document", () => {
  const READ: ShownPdfRead = {
    bytes: 5,
    downloadUrl: `blob:chrome-extension://${EXTENSION_ID}/1`,
    fetchedUrl: "https://fixture-library.test/decisions/42",
    type: "read",
  };
  const request = {
    maxBytes: 1024,
    url: "https://fixture-library.test/decisions/42",
  };
  const closedPort = () => {
    throw new TypeError("Attempting to use a disconnected port object");
  };

  test("bytes nobody can be told about are freed at once", async () => {
    const revoked: string[] = [];
    await answerShownPdfRead(request, closedPort, {
      read: async () => await Promise.resolve(READ),
      revoke: (downloadUrl) => {
        revoked.push(downloadUrl);
      },
    });
    expect(revoked).toEqual([READ.downloadUrl]);
  });

  test("an answer posted keeps its bytes, and a refusal has none to free", async () => {
    const posted: ShownPdfRead[] = [];
    const revoked: string[] = [];
    const revoke = (downloadUrl: string) => {
      revoked.push(downloadUrl);
    };
    await answerShownPdfRead(
      request,
      (answer) => {
        posted.push(answer);
      },
      { read: async () => await Promise.resolve(READ), revoke },
    );
    await answerShownPdfRead(request, closedPort, {
      read: async () =>
        await Promise.resolve<ShownPdfRead>({
          reason: "redirected",
          type: "refused",
        }),
      revoke,
    });
    expect(posted).toEqual([READ]);
    expect(revoked).toEqual([]);
  });
});

describe("the worker's reader", () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

  afterEach(() => {
    if (originalChrome) {
      Object.defineProperty(globalThis, "chrome", originalChrome);
    } else {
      Reflect.deleteProperty(globalThis, "chrome");
    }
  });

  type FakePort = {
    answer: (message: unknown) => void;
    close: () => void;
    disconnected: boolean;
    posted: unknown[];
  };

  /**
   * The offscreen document is open; each port the worker opens is kept so
   * a test can answer, close or ignore it. Timers run only when a test
   * runs them out.
   */
  const installReader = () => {
    const ports: FakePort[] = [];
    const opened = Promise.withResolvers<undefined>();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          connect: () => {
            const messageListeners: ((message: unknown) => void)[] = [];
            const disconnectListeners: (() => void)[] = [];
            const port: FakePort = {
              answer: (message) => {
                for (const listener of messageListeners) {
                  listener(message);
                }
              },
              close: () => {
                for (const listener of disconnectListeners) {
                  listener();
                }
              },
              disconnected: false,
              posted: [],
            };
            ports.push(port);
            opened.resolve(undefined);
            return {
              disconnect: () => {
                port.disconnected = true;
              },
              onDisconnect: {
                addListener: (listener: () => void) => {
                  disconnectListeners.push(listener);
                },
              },
              onMessage: {
                addListener: (listener: (message: unknown) => void) => {
                  messageListeners.push(listener);
                },
              },
              postMessage: (message: unknown) => {
                port.posted.push(message);
              },
            };
          },
          getContexts: async () => await Promise.resolve([{}]),
        },
      },
    });
    const timers: { ms: number; task: () => void }[] = [];
    const reader = createOffscreenShownPdfReader((task, ms) => {
      const timer = { ms, task };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index !== -1) {
          timers.splice(index, 1);
        }
      };
    });
    return { opened: opened.promise, ports, reader, timers };
  };

  const ADDRESS = "https://fixture-library.test/decisions/42";

  test("a document that never answers frees the read at its deadline", async () => {
    const { opened, ports, reader, timers } = installReader();

    const reading = reader.read(ADDRESS, 1024);
    await opened;
    expect(timers).toHaveLength(1);
    for (const { task } of [...timers]) {
      task();
    }

    expect(await reading).toEqual({ reason: "interrupted", type: "refused" });
    expect(ports[0]?.disconnected).toBe(true);
  });

  test("a document that closes the port, or is gone, ends the read as interrupted", async () => {
    const { opened, ports, reader, timers } = installReader();

    const reading = reader.read(ADDRESS, 1024);
    await opened;
    ports[0]?.close();

    expect(await reading).toEqual({ reason: "interrupted", type: "refused" });
    expect(timers).toEqual([]);
  });

  test("an answer is taken, its deadline ended and the port closed", async () => {
    const { opened, ports, reader, timers } = installReader();
    const answer: ShownPdfRead = {
      bytes: 5,
      downloadUrl: `blob:chrome-extension://${EXTENSION_ID}/2`,
      fetchedUrl: ADDRESS,
      type: "read",
    };

    const reading = reader.read(ADDRESS, 1024);
    await opened;
    expect(ports[0]?.posted).toEqual([
      {
        maxBytes: 1024,
        target: "stella-shown-pdf-reader",
        type: "read",
        url: ADDRESS,
      },
    ]);
    ports[0]?.answer(answer);

    expect(await reading).toEqual(answer);
    expect(timers).toEqual([]);
    expect(ports[0]?.disconnected).toBe(true);
  });
});
