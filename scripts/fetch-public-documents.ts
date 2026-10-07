import dns from "node:dns/promises";
import { mkdir, rename } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import nodePath from "node:path";
import { Readable } from "node:stream";

import { sha256Hex } from "../packages/sha256/src/node.ts";

class PublicDocumentFetchError extends Error {
  readonly reason: FailureReason;
  constructor(message: string, reason: FailureReason = "http-error") {
    super(message);
    this.name = "PublicDocumentFetchError";
    this.reason = reason;
  }
}

export const MAX_URLS = 100;
export const MAX_INPUT_BYTES = 60_000;
export const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 4;
export const TIMEOUT_MS = 20_000;
export const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;
const SETUP_UPLOAD_MINUTES = 10;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type FailureReason =
  | "dns"
  | "connect-timeout"
  | "tls"
  | "http-error"
  | "too-large"
  | "invalid-url"
  | "non-public-destination";
type Redirect = { url: string; status: number; location: string };
type Attempt = {
  url: string;
  status: number | null;
  reason: FailureReason | null;
  retryDelayMs: number;
};
type Archive = { path: string; sha256: string; size: number };
export type DocumentRecord = {
  url: string;
  retrievedAt: string;
  status: number | null;
  finalUrl: string | null;
  contentType: string | null;
  redirects: Redirect[];
  attempts: Attempt[];
  reason: FailureReason | null;
  archive: Archive | null;
  extraction:
    | { status: "extracted"; archive: Archive }
    | { status: "failed" }
    | null;
};

export const validateUrl = (input: string) => {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new PublicDocumentFetchError(
      "Public document URL must use HTTPS without credentials",
    );
  }
  return url.toString();
};

export const parseUrls = (input: string) => {
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    throw new PublicDocumentFetchError("URL input exceeds byte limit");
  }
  const urls = input
    .split(/\r?\n/u)
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls.length || urls.length > MAX_URLS) {
    throw new PublicDocumentFetchError("URL count must be between 1 and 100");
  }
  return urls.map(validateUrl);
};

export const classifyFailure = (error: unknown): FailureReason => {
  if (error instanceof PublicDocumentFetchError) {
    return error.reason;
  }
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (!seen.has(current)) {
    seen.add(current);
    parts.push(String(current));
    if (!(current instanceof Error)) {
      break;
    }
    if ("code" in current) {
      parts.push(String(current.code));
    }
    current = current.cause;
  }
  const message = parts.join(" ");
  if (/ENOTFOUND|EAI_AGAIN|DNS/iu.test(message)) {
    return "dns";
  }
  if (/TLS|SSL|CERT|certificate/iu.test(message)) {
    return "tls";
  }
  if (/timeout|timed out|abort/iu.test(message)) {
    return "connect-timeout";
  }
  return "http-error";
};

const save = async (
  root: string,
  bytes: Uint8Array,
  extension: string,
): Promise<Archive> => {
  const sha256 = sha256Hex(bytes);
  const path = `files/${sha256}.${extension}`;
  await Bun.write(nodePath.resolve(root, path), bytes);
  return { path, sha256, size: bytes.byteLength };
};

const readBounded = async (stream: ReadableStream<Uint8Array> | null) => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (stream) {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        return { status: "too-large" } as const;
      }
      chunks.push(chunk);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "read", bytes } as const;
};

export const extractPdf = async (path: string) => {
  const child = Bun.spawn(["pdftotext", "-layout", path, "-"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => {
    child.kill();
  }, TIMEOUT_MS);
  try {
    const result = await readBounded(child.stdout);
    if (result.status === "too-large") {
      throw new PublicDocumentFetchError("PDF text exceeds size limit");
    }
    if ((await child.exited) !== 0) {
      throw new PublicDocumentFetchError("PDF extraction failed");
    }
    return result.bytes;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
};

export const fetchBudgetMinutes = (urlCount: number) => {
  if (!Number.isInteger(urlCount) || urlCount < 1 || urlCount > MAX_URLS) {
    throw new PublicDocumentFetchError("URL count is outside the fetch budget");
  }
  // Retries are shared by the entire document, including its redirect chain.
  const requests = MAX_REDIRECTS + 1 + MAX_RETRIES;
  const documentMs =
    requests * TIMEOUT_MS + MAX_RETRIES * MAX_RETRY_DELAY_MS + TIMEOUT_MS;
  return Math.ceil((Math.ceil(urlCount / CONCURRENCY) * documentMs) / 60_000);
};
export const jobBudgetMinutes = (urlCount: number) =>
  fetchBudgetMinutes(urlCount) + SETUP_UPLOAD_MINUTES;

type RetryDelayOptions = {
  retryIndex: number;
  random: () => number;
  now: () => number;
};
export const retryDelayMs = (
  retryAfter: string | null,
  { retryIndex, random, now }: RetryDelayOptions,
) => {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const date = retryAfter === null ? Number.NaN : Date.parse(retryAfter);
  let providerDelay = 0;
  if (Number.isFinite(seconds)) {
    providerDelay = Math.max(0, seconds * 1000);
  } else if (Number.isFinite(date)) {
    providerDelay = Math.max(0, date - now());
  }
  const jitter = Math.floor(500 * 2 ** retryIndex * (1 + random()));
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(providerDelay, jitter));
};
const delay = async (milliseconds: number) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

// This script runs without installed packages in a sparse checkout.
const isGlobalAddress = (address: string) => {
  const family = net.isIP(address);
  const blocked = new net.BlockList();
  if (family === 4) {
    for (const cidr of [
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.0.2.0/24",
      "192.88.99.0/24",
      "192.168.0.0/16",
      "198.18.0.0/15",
      "198.51.100.0/24",
      "203.0.113.0/24",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ]) {
      const separator = cidr.indexOf("/");
      blocked.addSubnet(
        cidr.slice(0, separator),
        Number(cidr.slice(separator + 1)),
        "ipv4",
      );
    }
    return !blocked.check(address, "ipv4");
  }
  if (family !== 6) {
    return false;
  }
  const global = new net.BlockList();
  global.addSubnet("2000::", 3, "ipv6");
  for (const [subnet, prefix] of [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
  ] as const) {
    blocked.addSubnet(subnet, prefix, "ipv6");
  }
  return global.check(address, "ipv6") && !blocked.check(address, "ipv6");
};
const resolveHost = async (hostname: string) =>
  dns.lookup(hostname, { all: true });
const resolveDestination = async (
  url: string,
  resolver: typeof resolveHost,
) => {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/gu, "");
  const family = net.isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await resolver(hostname);
  if (addresses.some(({ address }) => !isGlobalAddress(address))) {
    throw new PublicDocumentFetchError(
      "Destination is not public",
      "non-public-destination",
    );
  }
  const address = addresses.at(0);
  if (!address) {
    throw new PublicDocumentFetchError("DNS returned no addresses", "dns");
  }
  return address;
};
const withAbort = async <T>(operation: Promise<T>, signal: AbortSignal) => {
  let onAbort = () => {
    signal.throwIfAborted();
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        new PublicDocumentFetchError("Request timeout", "connect-timeout"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

type PinnedFetchOptions = {
  address: string;
  family: number;
  signal: AbortSignal;
  redirect: "manual";
  headers: { "User-Agent": string };
};
const pinnedFetch = async (
  url: string,
  { address, family, signal, headers }: PinnedFetchOptions,
) =>
  await new Promise<Response>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers,
        signal,
        agent: false,
        // TLS and Host use the URL hostname; the socket uses only the checked address.
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [{ address, family }]);
            return;
          }
          callback(null, address, family);
        },
      },
      (response) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) {
            continue;
          }
          for (const item of Array.isArray(value) ? value : [value]) {
            responseHeaders.append(name, item);
          }
        }
        const status = response.statusCode ?? 500;
        const body = [204, 205, 304].includes(status)
          ? null
          : Readable.toWeb(response);
        try {
          resolve(new Response(body, { status, headers: responseHeaders }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    request.on("error", reject);
    request.end();
  });

type FetchDocumentOptions = {
  root: string;
  fetcher?: typeof pinnedFetch;
  resolver?: typeof resolveHost;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  extractor?: (path: string) => Promise<Uint8Array>;
};
const documentExtension = (pdf: boolean, contentType: string | null) => {
  if (pdf) {
    return "pdf";
  }
  if (/html/iu.test(contentType ?? "")) {
    return "html";
  }
  if (/^text\//iu.test(contentType ?? "")) {
    return "txt";
  }
  return "bin";
};

const isRetryable = (reason: FailureReason, status: number | null) =>
  reason === "dns" ||
  reason === "connect-timeout" ||
  status === 429 ||
  (status !== null && status >= 500);

export const fetchDocument = async (
  input: string,
  {
    root,
    fetcher = pinnedFetch,
    extractor = extractPdf,
    resolver = resolveHost,
    sleep = delay,
    random = Math.random,
    now = Date.now,
  }: FetchDocumentOptions,
): Promise<DocumentRecord> => {
  const record: DocumentRecord = {
    url: input,
    retrievedAt: new Date().toISOString(),
    status: null,
    finalUrl: null,
    contentType: null,
    redirects: [],
    attempts: [],
    reason: null,
    archive: null,
    extraction: null,
  };
  let url: string;
  try {
    url = validateUrl(input);
  } catch {
    return { ...record, reason: "invalid-url" };
  }
  await mkdir(nodePath.resolve(root, "files"), { recursive: true });
  let retries = 0;
  for (;;) {
    const attempt: Attempt = {
      url,
      status: null,
      reason: null,
      retryDelayMs: 0,
    };
    record.attempts.push(attempt);
    let retryAfter: string | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    record.finalUrl = url;
    record.status = null;
    record.contentType = null;
    try {
      const destination = await withAbort(
        resolveDestination(url, resolver),
        controller.signal,
      );
      const response = await fetcher(url, {
        ...destination,
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
      record.status = response.status;
      attempt.status = response.status;
      retryAfter = response.headers.get("retry-after");
      if (
        (response.status === 429 || response.status >= 500) &&
        retries < MAX_RETRIES
      ) {
        await response.body?.cancel();
        throw new PublicDocumentFetchError("HTTP response is retryable");
      }
      record.contentType = response.headers.get("content-type");
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || record.redirects.length >= MAX_REDIRECTS) {
          attempt.reason = "http-error";
          return { ...record, reason: "http-error" };
        }
        record.redirects.push({ url, status: response.status, location });
        try {
          url = validateUrl(new URL(location, url).toString());
        } catch {
          attempt.reason = "invalid-url";
          return { ...record, reason: "invalid-url" };
        }
        continue;
      }
      if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
        attempt.reason = "too-large";
        return { ...record, reason: "too-large" };
      }
      const body = await readBounded(response.body);
      if (body.status === "too-large") {
        attempt.reason = "too-large";
        return { ...record, reason: "too-large" };
      }
      const bytes = body.bytes;
      const pdf =
        new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-" ||
        /application\/pdf/iu.test(record.contentType ?? "");
      record.archive = await save(
        root,
        bytes,
        documentExtension(pdf, record.contentType),
      );
      record.reason = response.ok ? null : "http-error";
      attempt.reason = record.reason;
      if (pdf) {
        try {
          const text = await extractor(
            nodePath.resolve(root, record.archive.path),
          );
          if (text.byteLength > MAX_RESPONSE_BYTES) {
            throw new PublicDocumentFetchError("PDF text exceeds size limit");
          }
          record.extraction = {
            status: "extracted",
            archive: await save(root, text, "txt"),
          };
        } catch {
          record.extraction = { status: "failed" };
        }
      }
      return record;
    } catch (error) {
      const reason = classifyFailure(error);
      attempt.reason = reason;
      if (!isRetryable(reason, record.status) || retries >= MAX_RETRIES) {
        return { ...record, reason };
      }
      attempt.retryDelayMs = retryDelayMs(retryAfter, {
        retryIndex: retries,
        random,
        now,
      });
      retries++;
      clearTimeout(timer);
      controller.abort();
      await sleep(attempt.retryDelayMs);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
};

export const fetchDocuments = async (
  input: string,
  options: FetchDocumentOptions,
) => {
  const urls = parseUrls(input);
  const records: DocumentRecord[] = [];
  let next = 0;
  await mkdir(options.root, { recursive: true });
  const manifest = nodePath.resolve(options.root, "manifest.json");
  const temporaryManifest = `${manifest}.tmp`;
  await Bun.write(manifest, "[]");
  let checkpoint = Promise.resolve();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
      for (;;) {
        const index = next++;
        const url = urls.at(index);
        if (url === undefined) {
          return;
        }
        records[index] = await fetchDocument(url, options);
        const snapshot = JSON.stringify(records.filter(Boolean), null, 2);
        checkpoint = checkpoint.then(async () => {
          await Bun.write(temporaryManifest, snapshot);
          await rename(temporaryManifest, manifest);
          return;
        });
        await checkpoint;
      }
    }),
  );
  await checkpoint;
  return records;
};

if (import.meta.main) {
  const input = process.env["PUBLIC_DOCUMENT_URLS"] ?? "";
  await fetchDocuments(input, {
    root: nodePath.resolve("public-documents"),
  });
}
