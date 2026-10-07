import { mkdir } from "node:fs/promises";
import nodePath from "node:path";

import { sha256Hex } from "../packages/sha256/src/node.ts";

class PublicDocumentFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicDocumentFetchError";
  }
}

export const MAX_URLS = 200;
export const MAX_INPUT_BYTES = 60_000;
export const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 4;
const TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type FailureReason =
  | "dns"
  | "connect-timeout"
  | "tls"
  | "http-error"
  | "too-large"
  | "invalid-url";
type Redirect = { url: string; status: number; location: string };
type Archive = { path: string; sha256: string; size: number };
export type DocumentRecord = {
  url: string;
  retrievedAt: string;
  status: number | null;
  finalUrl: string | null;
  contentType: string | null;
  redirects: Redirect[];
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
    throw new PublicDocumentFetchError("URL count must be between 1 and 200");
  }
  return urls.map(validateUrl);
};

export const classifyFailure = (error: unknown): FailureReason => {
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

type FetchDocumentOptions = {
  root: string;
  fetcher?: (url: string, options: RequestInit) => Promise<Response>;
  extractor?: (path: string) => Promise<Uint8Array>;
};
export const fetchDocument = async (
  input: string,
  { root, fetcher = fetch, extractor = extractPdf }: FetchDocumentOptions,
): Promise<DocumentRecord> => {
  const record: DocumentRecord = {
    url: input,
    retrievedAt: new Date().toISOString(),
    status: null,
    finalUrl: null,
    contentType: null,
    redirects: [],
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
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    record.finalUrl = url;
    record.status = null;
    record.contentType = null;
    try {
      const response = await fetcher(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
      record.status = response.status;
      record.contentType = response.headers.get("content-type");
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || record.redirects.length >= MAX_REDIRECTS) {
          return { ...record, reason: "http-error" };
        }
        record.redirects.push({ url, status: response.status, location });
        try {
          url = validateUrl(new URL(location, url).toString());
        } catch {
          return { ...record, reason: "invalid-url" };
        }
        continue;
      }
      if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
        return { ...record, reason: "too-large" };
      }
      const body = await readBounded(response.body);
      if (body.status === "too-large") {
        return { ...record, reason: "too-large" };
      }
      const bytes = body.bytes;
      const pdf =
        new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-" ||
        /application\/pdf/iu.test(record.contentType ?? "");
      let extension = "bin";
      if (pdf) {
        extension = "pdf";
      } else if (/html/iu.test(record.contentType ?? "")) {
        extension = "html";
      } else if (/^text\//iu.test(record.contentType ?? "")) {
        extension = "txt";
      }
      record.archive = await save(root, bytes, extension);
      record.reason = response.ok ? null : "http-error";
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
      return { ...record, reason: classifyFailure(error) };
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
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
      for (;;) {
        const index = next++;
        const url = urls.at(index);
        if (url === undefined) {
          return;
        }
        records[index] = await fetchDocument(url, options);
      }
    }),
  );
  await Bun.write(
    nodePath.resolve(options.root, "manifest.json"),
    JSON.stringify(records, null, 2),
  );
  return records;
};

if (import.meta.main) {
  await fetchDocuments(process.env.PUBLIC_DOCUMENT_URLS ?? "", {
    root: nodePath.resolve("public-documents"),
  });
}
