import { createRandomValue } from "@/lib/uuid";

export type ContentSecurityPolicyEnvironment = {
  apiBase: string;
  browserApiBase?: string | undefined;
  collabUrl?: string | undefined;
  desktopBridgePort: number;
  documentsBucket: string;
  documentsEndpoint: string;
  posthogHost?: string | undefined;
  sandboxUrl: string;
};

const origin = (url: string): string => new URL(url).origin;

const isAwsS3Endpoint = (endpoint: string): boolean => {
  const hostname = new URL(endpoint).hostname.toLowerCase();
  return hostname.includes("s3") && hostname.endsWith(".amazonaws.com");
};

export const documentsBucketOrigin = (
  endpoint: string,
  bucket: string,
): string => {
  const parsed = new URL(endpoint);
  if (!isAwsS3Endpoint(endpoint)) {
    return parsed.origin;
  }
  parsed.hostname = `${bucket}.${parsed.hostname}`;
  return parsed.origin;
};

export const createContentSecurityPolicyNonce = (): string =>
  createRandomValue();

export const buildContentSecurityPolicy = (
  nonce: string,
  environment: ContentSecurityPolicyEnvironment,
): string => {
  const apiOrigin = origin(environment.browserApiBase ?? environment.apiBase);
  const posthogOrigin = environment.posthogHost
    ? origin(environment.posthogHost)
    : null;
  const collabOrigin = environment.collabUrl
    ? origin(environment.collabUrl)
    : null;
  const documentOrigin = documentsBucketOrigin(
    environment.documentsEndpoint,
    environment.documentsBucket,
  );
  const sandboxOrigin = origin(environment.sandboxUrl);
  const connectSources = [
    "'self'",
    apiOrigin,
    posthogOrigin,
    collabOrigin,
    documentOrigin,
    `http://127.0.0.1:${environment.desktopBridgePort}`,
    "https://api.github.com",
  ].filter((source): source is string => source !== null);

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${posthogOrigin === null ? "" : ` ${posthogOrigin}`}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://lh3.googleusercontent.com ${apiOrigin} ${documentOrigin}`,
    "font-src 'self' data:",
    `connect-src ${[...new Set(connectSources)].join(" ")}`,
    "worker-src 'self' blob:",
    `frame-src 'self' blob: ${sandboxOrigin}`,
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
};
