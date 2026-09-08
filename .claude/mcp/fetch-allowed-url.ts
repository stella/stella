const DOC_FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOC_ACCEPT_HEADER =
  "text/markdown, text/plain;q=0.9, text/html;q=0.5, */*;q=0.1";

export type FetchedAllowedUrl = {
  contentType: string | null;
  text: string;
  url: string;
};

type FetchAllowedUrlProps = {
  allowedHosts: ReadonlySet<string>;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  maxResponseBytes?: number;
  timeoutMs?: number;
  url: string;
};

export const isAllowedDocUrl = (
  url: string,
  allowedHosts: ReadonlySet<string>,
) => {
  const parsedUrl = new URL(url);
  return (
    parsedUrl.protocol === "https:" && allowedHosts.has(parsedUrl.hostname)
  );
};

export const fetchAllowedUrl = async ({
  allowedHosts,
  fetchImpl = fetch,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  timeoutMs = DOC_FETCH_TIMEOUT_MS,
  url,
}: FetchAllowedUrlProps): Promise<FetchedAllowedUrl> => {
  let currentUrl = new URL(url);
  const signal = AbortSignal.timeout(timeoutMs);

  for (let requestIndex = 0; requestIndex <= MAX_REDIRECTS; requestIndex += 1) {
    validateAllowedUrl(currentUrl, allowedHosts);

    const response = await fetchImpl(currentUrl, {
      headers: { Accept: DOC_ACCEPT_HEADER },
      redirect: "manual",
      signal,
    });

    if (!isRedirectStatus(response.status)) {
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return {
        contentType: response.headers.get("content-type"),
        text: await readLimitedText({
          maxBytes: maxResponseBytes,
          response,
        }),
        url: currentUrl.toString(),
      };
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`${response.status} redirect missing Location header`);
    }

    currentUrl = new URL(location, currentUrl);
  }

  throw new Error("Too many redirects while fetching documentation");
};

const validateAllowedUrl = (
  url: URL,
  allowedHosts: ReadonlySet<string>,
): void => {
  if (url.protocol !== "https:") {
    throw new Error(`Blocked: ${url.protocol} is not allowed for doc sources`);
  }

  if (!allowedHosts.has(url.hostname)) {
    throw new Error(`Blocked: ${url.hostname} is not a configured doc source`);
  }
};

const isRedirectStatus = (status: number) =>
  status === 301 ||
  status === 302 ||
  status === 303 ||
  status === 307 ||
  status === 308;

const readLimitedText = async ({
  maxBytes,
  response,
}: {
  maxBytes: number;
  response: Response;
}): Promise<string> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error("Documentation response exceeds size limit");
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const value: unknown = result.value;
    if (!(value instanceof Uint8Array)) {
      throw new TypeError(
        "Documentation response returned an invalid byte chunk",
      );
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("Documentation response exceeds size limit");
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
};
