const DOC_FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

type FetchAllowedUrlProps = {
  allowedHosts: ReadonlySet<string>;
  fetchImpl?: typeof fetch;
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
}: FetchAllowedUrlProps): Promise<string> => {
  let currentUrl = new URL(url);
  const signal = AbortSignal.timeout(timeoutMs);

  for (let requestIndex = 0; requestIndex <= MAX_REDIRECTS; requestIndex += 1) {
    validateAllowedUrl(currentUrl, allowedHosts);

    const response = await fetchImpl(currentUrl, {
      redirect: "manual",
      signal,
    });

    if (!isRedirectStatus(response.status)) {
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await readLimitedText({
        maxBytes: maxResponseBytes,
        response,
      });
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
    const { done, value } = await reader.read();
    if (done) {
      break;
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
