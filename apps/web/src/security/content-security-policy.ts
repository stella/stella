import { createRandomValue } from "@/lib/uuid";

export type ContentSecurityPolicyEnvironment = {
  apiBase: string;
  browserApiBase?: string | undefined;
  collabUrl?: string | undefined;
  desktopBridgePort: number;
  documentsBucket: string;
  documentsEndpoint: string;
  posthogHost?: string | undefined;
  /** Every sandbox document the app frames (`frameSandboxUrls`). */
  sandboxUrls: readonly string[];
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

/**
 * How a document's own scripts are admitted:
 * - `nonce`: a private document carries a fresh nonce per response, and code
 *   those scripts load is trusted transitively (`'strict-dynamic'`).
 * - `hashes`: a document a shared cache may store is sent to many viewers, so
 *   its policy names only the base64 SHA-256 of each inline script it holds.
 *   A parser-inserted `<script src>` cannot be admitted by a hash in every
 *   browser, so `'self'` stays in force here (no `'strict-dynamic'`) and admits
 *   the same-origin bootstrap files and lazy chunks.
 */
type DocumentScriptSources =
  | { kind: "nonce"; nonce: string }
  | { kind: "hashes"; hashes: readonly string[] };

const scriptSourceExpressions = (
  scripts: DocumentScriptSources,
): readonly string[] =>
  scripts.kind === "nonce"
    ? [`'nonce-${scripts.nonce}'`, "'strict-dynamic'"]
    : scripts.hashes.map((hash) => `'sha256-${hash}'`);

export const buildContentSecurityPolicy = (
  scripts: DocumentScriptSources,
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
  const sandboxOrigins = [...new Set(environment.sandboxUrls.map(origin))];
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
    [
      "script-src 'self'",
      ...scriptSourceExpressions(scripts),
      "'wasm-unsafe-eval'",
      ...(posthogOrigin === null ? [] : [posthogOrigin]),
    ].join(" "),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://lh3.googleusercontent.com ${apiOrigin} ${documentOrigin}`,
    "font-src 'self' data:",
    `connect-src ${[...new Set(connectSources)].join(" ")}`,
    "worker-src 'self' blob:",
    `frame-src 'self' blob: ${sandboxOrigins.join(" ")}`,
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
};
