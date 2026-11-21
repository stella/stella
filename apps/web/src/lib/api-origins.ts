import { env } from "@/env";

export const externalApiOrigin = (): string => env.VITE_API_URL;

export const browserApiBaseUrl = (): string =>
  env.VITE_BROWSER_API_URL ?? externalApiOrigin();

export const browserAuthBaseUrl = (): string => {
  if (env.VITE_BROWSER_API_URL === undefined) {
    return externalApiOrigin();
  }
  return new URL(env.VITE_BROWSER_API_URL).origin;
};

export const browserApiRootUrl = (path: `/${string}`): string => {
  if (env.VITE_BROWSER_API_URL === undefined) {
    return new URL(path, externalApiOrigin()).toString();
  }
  return `${env.VITE_BROWSER_API_URL}${path}`;
};

// File URLs the API returns (content grants) are built on its public origin.
// A same-origin build reaches the API only through the /api path (and its CSP
// allows only that), so map those URLs onto the browser API base. URLs on any
// other origin (storage presigned URLs) are returned unchanged.
export const mapApiUrlToBrowserBase = (
  url: string,
  {
    apiOrigin,
    browserApiBase,
  }: { apiOrigin: string; browserApiBase: string | undefined },
): string => {
  if (browserApiBase === undefined) {
    return url;
  }
  const parsed = URL.parse(url);
  if (parsed === null || parsed.origin !== new URL(apiOrigin).origin) {
    return url;
  }
  return `${browserApiBase}${parsed.pathname}${parsed.search}${parsed.hash}`;
};

export const toBrowserApiUrl = (url: string): string =>
  mapApiUrlToBrowserBase(url, {
    apiOrigin: externalApiOrigin(),
    browserApiBase: env.VITE_BROWSER_API_URL,
  });
