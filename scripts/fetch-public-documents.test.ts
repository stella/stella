import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { sha256Hex } from "../packages/sha256/src/node.ts";
import {
  classifyFailure,
  fetchDocument,
  fetchDocuments,
  MAX_INPUT_BYTES,
  MAX_RESPONSE_BYTES,
  parseUrls,
} from "./fetch-public-documents";

const roots: string[] = [];
const makeRoot = async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), "public-documents-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const digest = sha256Hex;

test("URL inputs enforce count, byte cap and HTTPS without credentials", () => {
  expect(
    parseUrls(" https://example.com/a\r\n\nhttps://example.com/b "),
  ).toEqual(["https://example.com/a", "https://example.com/b"]);
  expect(
    parseUrls(
      Array.from({ length: 200 }, () => "https://example.com").join("\n"),
    ),
  ).toHaveLength(200);
  expect(() => parseUrls("")).toThrow("URL count");
  expect(() =>
    parseUrls(
      Array.from({ length: 201 }, () => "https://example.com").join("\n"),
    ),
  ).toThrow("URL count");
  expect(() =>
    parseUrls(`https://example.com/${"é".repeat(MAX_INPUT_BYTES / 2)}`),
  ).toThrow("byte limit");
  for (const url of [
    "http://example.com",
    "file:///x",
    "ftp://example.com",
    "https://user:pass@example.com",
  ]) {
    expect(() => parseUrls(url)).toThrow("HTTPS without credentials");
  }
  expect(() => parseUrls("invalid")).toThrow(TypeError);
  expect(
    classifyFailure(
      new Error("fetch failed", {
        cause: Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }),
      }),
    ),
  ).toBe("dns");
});

test("scheme refusal prevents requests including redirected downgrades", async () => {
  const root = await makeRoot();
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    return new Response(null, {
      status: 302,
      headers: { location: "http://example.com/file" },
    });
  };
  expect(
    (await fetchDocument("http://example.com", { root, fetcher })).reason,
  ).toBe("invalid-url");
  expect(calls).toEqual([]);
  const record = await fetchDocument("https://example.com", { root, fetcher });
  expect(record.reason).toBe("invalid-url");
  expect(calls).toEqual(["https://example.com/"]);
  expect(record.redirects).toEqual([
    {
      url: "https://example.com/",
      status: 302,
      location: "http://example.com/file",
    },
  ]);
});

test("redirect chains preserve every hop and stop after five redirects", async () => {
  const root = await makeRoot();
  const calls: string[] = [];
  const fetcher = async (url: string, options: RequestInit) => {
    calls.push(url);
    expect(options.redirect).toBe("manual");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(options.headers).get("user-agent")).toContain(
      "Mozilla/5.0",
    );
    return calls.length <= 5
      ? new Response(null, {
          status: 301,
          headers: { location: `/file${calls.length}` },
        })
      : new Response("document", { headers: { "content-type": "text/plain" } });
  };
  const record = await fetchDocument("https://example.com", { root, fetcher });
  expect(record.redirects).toHaveLength(5);
  expect(record.finalUrl).toBe("https://example.com/file5");
  expect(record.reason).toBeNull();
  expect(record.archive).toEqual({
    path: `files/${digest("document")}.txt`,
    sha256: digest("document"),
    size: 8,
  });
  let count = 0;
  const loop = await fetchDocument("https://example.com", {
    root,
    fetcher: async () => {
      count++;
      return new Response(null, {
        status: 302,
        headers: { location: "/loop" },
      });
    },
  });
  expect(loop.reason).toBe("http-error");
  expect(loop.redirects).toHaveLength(5);
  expect(count).toBe(6);
  const missing = await fetchDocument("https://example.com", {
    root,
    fetcher: async () => new Response(null, { status: 302 }),
  });
  expect(missing.reason).toBe("http-error");
});

test("network failures use typed reasons without fabricated HTTP statuses", async () => {
  const root = await makeRoot();
  for (const [message, reason] of [
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["certificate expired", "tls"],
    ["TimeoutError", "connect-timeout"],
    ["ECONNRESET", "http-error"],
  ]) {
    expect(classifyFailure(new Error(message))).toBe(reason);
    const record = await fetchDocument("https://example.com", {
      root,
      fetcher: async () => {
        throw new Error(message);
      },
    });
    expect(record.status).toBeNull();
    expect(record.reason).toBe(reason);
    expect(record.archive).toBeNull();
  }
});

test("size cap rejects advertised and streamed oversized bodies without saving bytes", async () => {
  const root = await makeRoot();
  const advertised = await fetchDocument("https://example.com", {
    root,
    fetcher: async () =>
      new Response("small", {
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
      }),
  });
  expect(advertised.reason).toBe("too-large");
  expect(advertised.archive).toBeNull();
  const streamed = await fetchDocument("https://example.com", {
    root,
    fetcher: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
      ),
  });
  expect(streamed.reason).toBe("too-large");
  expect(streamed.archive).toBeNull();
  expect(await readdir(nodePath.join(root, "files"))).toEqual([]);
  const exact = await fetchDocument("https://example.com", {
    root,
    fetcher: async () => new Response(new Uint8Array(MAX_RESPONSE_BYTES)),
  });
  expect(exact.reason).toBeNull();
  expect(exact.archive?.size).toBe(MAX_RESPONSE_BYTES);
});

test("HTTP error bytes remain verifiable and PDF extraction has its own status", async () => {
  const root = await makeRoot();
  const error = await fetchDocument("https://example.com", {
    root,
    fetcher: async () => new Response("missing", { status: 404 }),
  });
  expect(error.status).toBe(404);
  expect(error.reason).toBe("http-error");
  expect(error.archive?.sha256).toBe(digest("missing"));
  const pdf = await fetchDocument("https://example.com", {
    root,
    fetcher: async () => new Response("%PDF-content"),
    extractor: async (path) => {
      expect(await readFile(path, "utf-8")).toBe("%PDF-content");
      return new TextEncoder().encode("extracted text");
    },
  });
  expect(pdf.archive?.path.endsWith(".pdf")).toBe(true);
  expect(pdf.extraction).toEqual({
    status: "extracted",
    archive: {
      path: `files/${digest("extracted text")}.txt`,
      sha256: digest("extracted text"),
      size: 14,
    },
  });
  const failed = await fetchDocument("https://example.com", {
    root,
    fetcher: async () =>
      new Response("broken", {
        headers: { "content-type": "application/pdf" },
      }),
    extractor: async () => {
      throw new Error("unreadable PDF");
    },
  });
  expect(failed.reason).toBeNull();
  expect(failed.extraction).toEqual({ status: "failed" });
  expect(failed.archive).not.toBeNull();
});

test("manifest preserves input order, hashes and bounded concurrency", async () => {
  const root = await makeRoot();
  let active = 0;
  let peak = 0;
  const records = await fetchDocuments(
    Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`).join("\n"),
    {
      root,
      fetcher: async (url) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        active--;
        return new Response(url, { headers: { "content-type": "text/plain" } });
      },
    },
  );
  expect(peak).toBe(4);
  expect(
    JSON.parse(await readFile(nodePath.join(root, "manifest.json"), "utf-8")),
  ).toEqual(records);
  for (const [index, record] of records.entries()) {
    const url = `https://example.com/${index}`;
    expect(record).toEqual({
      url,
      retrievedAt: expect.any(String),
      status: 200,
      finalUrl: url,
      contentType: "text/plain",
      redirects: [],
      reason: null,
      archive: {
        path: `files/${digest(url)}.txt`,
        sha256: digest(url),
        size: url.length,
      },
      extraction: null,
    });
    expect(
      await readFile(
        nodePath.join(root, record.archive?.path ?? "missing"),
        "utf-8",
      ),
    ).toBe(url);
  }
});

test("mutation guards detect weakened boundaries", async () => {
  const source = await readFile(
    new URL("fetch-public-documents.ts", import.meta.url),
    "utf-8",
  );
  const suite = await readFile(
    new URL("fetch-public-documents.test.ts", import.meta.url),
    "utf-8",
  );
  const mutations = [
    {
      marker: 'url.protocol !== "https:"',
      replacement: "false",
      title: "scheme refusal",
    },
    {
      marker: "> MAX_RESPONSE_BYTES",
      replacement: "> MAX_RESPONSE_BYTES + 1",
      title: "size cap",
    },
  ];
  for (const mutation of mutations) {
    expect(source).toContain(mutation.marker);
    const root = await makeRoot();
    await Bun.write(
      nodePath.join(root, "scripts/fetch-public-documents.ts"),
      source.replaceAll(mutation.marker, () => mutation.replacement),
    );
    await Bun.write(
      nodePath.join(root, "scripts/fetch-public-documents.test.ts"),
      suite,
    );
    for (const file of ["node.ts", "types.ts"]) {
      await Bun.write(
        nodePath.join(root, "packages/sha256/src", file),
        await readFile(
          new URL(`../packages/sha256/src/${file}`, import.meta.url),
        ),
      );
    }
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "fetch-public-documents.test.ts",
        "-t",
        mutation.title,
      ],
      { cwd: nodePath.join(root, "scripts"), stdout: "pipe", stderr: "pipe" },
    );
    const [output, errors, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).not.toBe(0);
    expect(output + errors).toMatch(/1 fail/u);
  }
});
