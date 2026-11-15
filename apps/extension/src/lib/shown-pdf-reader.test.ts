import { afterEach, describe, expect, test } from "bun:test";

import { readShownPdf } from "./shown-pdf-reader";

const PDF_BYTES = "%PDF-1.7\nfixture\n%%EOF\n";

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
