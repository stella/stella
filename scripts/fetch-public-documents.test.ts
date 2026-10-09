import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { sha256Hex } from "../packages/sha256/src/node.ts";
import {
  classifyFailure,
  fetchDocument,
  fetchDocuments,
  fetchBudgetMinutes,
  jobBudgetMinutes,
  retryDelayMs,
  MAX_URLS,
  TIMEOUT_MS,
  MAX_RETRIES,
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
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});
const digest = sha256Hex;
const deterministic = {
  resolver: async () => [{ address: "8.8.8.8", family: 4 }],
  sleep: async (_milliseconds: number) => {},
  random: () => 0.5,
  now: () => 0,
};

test("URL inputs enforce count, byte cap and HTTPS without credentials", () => {
  expect(
    parseUrls(" https://example.com/a\r\n\nhttps://example.com/b "),
  ).toEqual(["https://example.com/a", "https://example.com/b"]);
  expect(
    parseUrls(
      Array.from({ length: MAX_URLS }, () => "https://example.com").join("\n"),
    ),
  ).toHaveLength(MAX_URLS);
  expect(() => parseUrls("")).toThrow("URL count");
  expect(() =>
    parseUrls(
      Array.from({ length: MAX_URLS + 1 }, () => "https://example.com").join(
        "\n",
      ),
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
    (
      await fetchDocument("http://example.com", {
        root,
        ...deterministic,
        fetcher,
      })
    ).reason,
  ).toBe("invalid-url");
  expect(calls).toEqual([]);
  const record = await fetchDocument("https://example.com", {
    root,
    ...deterministic,
    fetcher,
  });
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
  const record = await fetchDocument("https://example.com", {
    root,
    ...deterministic,
    fetcher,
  });
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
    ...deterministic,
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
    ...deterministic,
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
  ] as const) {
    expect(classifyFailure(new Error(message))).toBe(reason);
    const record = await fetchDocument("https://example.com", {
      root,
      ...deterministic,
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
    ...deterministic,
    fetcher: async () =>
      new Response("small", {
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
      }),
  });
  expect(advertised.reason).toBe("too-large");
  expect(advertised.archive).toBeNull();
  const streamed = await fetchDocument("https://example.com", {
    root,
    ...deterministic,
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
    ...deterministic,
    fetcher: async () => new Response(new Uint8Array(MAX_RESPONSE_BYTES)),
  });
  expect(exact.reason).toBeNull();
  expect(exact.archive?.size).toBe(MAX_RESPONSE_BYTES);
});

test("HTTP error bytes remain verifiable and PDF extraction has its own status", async () => {
  const root = await makeRoot();
  const error = await fetchDocument("https://example.com", {
    root,
    ...deterministic,
    fetcher: async () => new Response("missing", { status: 404 }),
  });
  expect(error.status).toBe(404);
  expect(error.reason).toBe("http-error");
  expect(error.archive?.sha256).toBe(digest("missing"));
  const pdf = await fetchDocument("https://example.com", {
    root,
    ...deterministic,
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
    ...deterministic,
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
  // Hold the first fetches until four are in flight, so the bound is proven
  // without depending on how the runner schedules them.
  let releaseFetches = () => {};
  const allWorkersBusy = new Promise<void>((resolve) => {
    releaseFetches = resolve;
  });
  const records = await fetchDocuments(
    Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`).join("\n"),
    {
      root,
      ...deterministic,
      fetcher: async (url) => {
        active++;
        peak = Math.max(peak, active);
        if (active === 4) {
          releaseFetches();
        }
        await allWorkersBusy;
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
      attempts: [{ url, status: 200, reason: null, retryDelayMs: 0 }],
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

test("fetch budget covers all request batches and bounded retries", async () => {
  expect(TIMEOUT_MS).toBe(20_000);
  expect(MAX_RETRIES).toBe(2);
  expect(MAX_URLS).toBe(100);
  expect(fetchBudgetMinutes(1)).toBe(4);
  expect(fetchBudgetMinutes(4)).toBe(4);
  expect(fetchBudgetMinutes(5)).toBe(8);
  expect(fetchBudgetMinutes(MAX_URLS)).toBe(100);
  expect(jobBudgetMinutes(MAX_URLS)).toBe(110);
  const workflow = await readFile(
    new URL("../.github/workflows/fetch-public-documents.yml", import.meta.url),
    "utf-8",
  );
  expect(workflow).toContain(
    `    timeout-minutes: ${jobBudgetMinutes(MAX_URLS)}`,
  );
  expect(workflow).toContain(
    `        timeout-minutes: ${fetchBudgetMinutes(MAX_URLS)}`,
  );
  for (const invalid of [0, -1, MAX_URLS + 1, 1.5, Number.NaN]) {
    expect(() => fetchBudgetMinutes(invalid)).toThrow(
      "outside the fetch budget",
    );
  }
  for (let count = 1; count <= MAX_URLS; count++) {
    expect(fetchBudgetMinutes(count) * 60_000).toBeGreaterThanOrEqual(
      Math.ceil(count / 4) * (8 * TIMEOUT_MS + 2 * 30_000 + TIMEOUT_MS),
    );
    expect(jobBudgetMinutes(count) - fetchBudgetMinutes(count)).toBe(10);
  }
});

test("destinations must be global before each pinned request", async () => {
  const root = await makeRoot();
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return new Response("document");
  };
  const literal = await fetchDocument("https://127.0.0.1/file", {
    root,
    ...deterministic,
    fetcher,
  });
  expect(literal.reason).toBe("non-public-destination");
  const hostname = await fetchDocument("https://example.com/file", {
    root,
    ...deterministic,
    resolver: async () => [{ address: "10.0.0.1", family: 4 }],
    fetcher,
  });
  expect(hostname.reason).toBe("non-public-destination");
  expect(requests).toBe(0);
  expect(literal.attempts).toHaveLength(1);
  expect(hostname.attempts).toHaveLength(1);
  const redirected = await fetchDocument("https://example.com/file", {
    root,
    ...deterministic,
    fetcher: async (_url, options) => {
      requests++;
      expect(options.address).toBe("8.8.8.8");
      expect(options.family).toBe(4);
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/file" },
      });
    },
  });
  expect(redirected.reason).toBe("non-public-destination");
  expect(requests).toBe(1);
  expect(redirected.attempts.at(-1)?.reason).toBe("non-public-destination");
});

test("retry delays honor capped server hints and bounded jitter", () => {
  const now = () => Date.UTC(2026, 0, 1);
  const options = { retryIndex: 0, random: () => 0.5, now };
  expect(retryDelayMs("12", options)).toBe(12_000);
  expect(retryDelayMs("90", options)).toBe(30_000);
  expect(retryDelayMs(new Date(now() + 15_000).toUTCString(), options)).toBe(
    15_000,
  );
  expect(retryDelayMs(new Date(now() + 90_000).toUTCString(), options)).toBe(
    30_000,
  );
  for (const randomValue of [0, 0.5, 1]) {
    for (const retryIndex of [0, 1]) {
      const jittered = retryDelayMs(null, {
        retryIndex,
        random: () => randomValue,
        now,
      });
      expect(jittered).toBeGreaterThanOrEqual(0);
      expect(jittered).toBeLessThanOrEqual(30_000);
      expect(
        retryDelayMs("not a date", {
          retryIndex,
          random: () => randomValue,
          now,
        }),
      ).toBe(jittered);
    }
  }
  expect(retryDelayMs(null, { ...options, random: () => 0 })).not.toBe(
    retryDelayMs(null, { ...options, random: () => 1 }),
  );
  expect(retryDelayMs(null, { ...options, retryIndex: 1 })).toBeGreaterThan(
    retryDelayMs(null, options),
  );
});

test("temporary failures retry and manifest attempts retain their outcomes", async () => {
  const root = await makeRoot();
  const retryReasons = {
    dns: "dns",
    timeout: "connect-timeout",
    429: "http-error",
    503: "http-error",
  } as const;
  for (const failure of ["dns", "timeout", 429, 503] as const) {
    let calls = 0;
    const delays: number[] = [];
    const record = await fetchDocument("https://example.com/file", {
      root,
      ...deterministic,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      resolver: async () => {
        if (failure === "dns" && calls++ === 0) {
          throw new Error("ENOTFOUND");
        }
        return [{ address: "8.8.8.8", family: 4 }];
      },
      fetcher: async () => {
        if (failure !== "dns" && calls++ === 0) {
          if (failure === "timeout") {
            throw new Error("TimeoutError");
          }
          return new Response("temporary", {
            status: failure,
            headers: { "retry-after": "90" },
          });
        }
        return new Response("document");
      },
    });
    expect(record.reason).toBeNull();
    expect(record.status).toBe(200);
    expect(record.attempts).toHaveLength(2);
    expect(delays).toHaveLength(1);
    expect(record.attempts.at(0)?.retryDelayMs).toBe(delays.at(0));
    expect(record.attempts.at(0)?.reason).toBe(retryReasons[failure]);
    expect(record.attempts.at(-1)?.reason).toBeNull();
    if (typeof failure === "number") {
      expect(delays).toEqual([30_000]);
      expect(record.attempts.at(0)?.status).toBe(failure);
    }
  }
});

test("retry count is bounded across redirect hops", async () => {
  const root = await makeRoot();
  const statuses = [503, 302, 503, 503];
  let calls = 0;
  const delays: number[] = [];
  const record = await fetchDocument("https://example.com/file", {
    root,
    ...deterministic,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    fetcher: async () => {
      const status = statuses.at(calls++);
      if (status === undefined) {
        throw new Error("unexpected request");
      }
      return new Response("document", {
        status,
        headers: status === 302 ? { location: "/next" } : {},
      });
    },
  });
  expect(record.reason).toBe("http-error");
  expect(record.attempts.map((attempt) => attempt.status)).toEqual(statuses);
  expect(delays).toHaveLength(2);
  expect(calls).toBe(4);
  expect(record.finalUrl).toBe("https://example.com/next");
});

test("permanent HTTP and TLS failures are not retried", async () => {
  const root = await makeRoot();
  for (const failure of [403, "certificate expired"]) {
    let calls = 0;
    let sleeps = 0;
    const record = await fetchDocument("https://example.com/file", {
      root,
      ...deterministic,
      sleep: async () => {
        sleeps++;
      },
      fetcher: async () => {
        calls++;
        if (typeof failure === "string") {
          throw new TypeError(failure);
        }
        return new Response("refused", { status: failure });
      },
    });
    expect(calls).toBe(1);
    expect(sleeps).toBe(0);
    expect(record.attempts).toHaveLength(1);
    expect(record.reason).toBe(
      typeof failure === "string" ? "tls" : "http-error",
    );
  }
});

test("completed records are checkpointed while later documents remain pending", async () => {
  const root = await makeRoot();
  let releasePending: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  let startedPending: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    startedPending = resolve;
  });
  const completed = fetchDocuments(
    "https://example.com/first\nhttps://example.com/second",
    {
      root,
      ...deterministic,
      fetcher: async (url) => {
        if (url.endsWith("/second")) {
          startedPending();
          await pending;
        }
        return new Response(url);
      },
    },
  );
  await started;
  try {
    let partial: unknown = [];
    for (let turn = 0; turn < 100; turn++) {
      partial = JSON.parse(
        await readFile(nodePath.join(root, "manifest.json"), "utf-8"),
      );
      if (Array.isArray(partial) && partial.length > 0) {
        break;
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    expect(partial).toEqual([
      expect.objectContaining({
        url: "https://example.com/first",
        reason: null,
        status: 200,
      }),
    ]);
  } finally {
    releasePending();
    await completed;
  }
  expect(
    JSON.parse(await readFile(nodePath.join(root, "manifest.json"), "utf-8")),
  ).toEqual(await completed);
});
