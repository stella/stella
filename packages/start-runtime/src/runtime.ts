import { TaggedError } from "better-result";
import { file, serve } from "bun";
import nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_HEALTH_PATH = "/health";
const DEFAULT_IMMUTABLE_ASSET_PREFIX = "/assets/";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATED_CACHE_CONTROL = "public, max-age=300";

type StartFetchHandler = {
  fetch: (request: Request) => Response | Promise<Response>;
};

export class StartRuntimeError extends TaggedError("StartRuntimeError")<{
  code:
    | "empty-server-directory"
    | "invalid-directory"
    | "invalid-handler"
    | "server-module-resolution";
  failures?: readonly string[] | undefined;
  message: string;
}> {}

const isStartFetchHandler = (
  candidate: unknown,
): candidate is StartFetchHandler =>
  typeof candidate === "object" &&
  candidate !== null &&
  "fetch" in candidate &&
  typeof candidate.fetch === "function";

const requireFileDirectoryUrl = (url: URL): void => {
  if (url.protocol === "file:" && url.pathname.endsWith("/")) {
    return;
  }

  throw new StartRuntimeError({
    code: "invalid-directory",
    message:
      "Runtime directories must be absolute file URLs ending in a slash.",
  });
};

const resolveClientAssetUrl = (
  requestUrl: URL,
  clientDirectoryUrl: URL,
): URL | null => {
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    return null;
  }

  if (pathname.endsWith("/")) {
    return null;
  }

  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }

  const fileName = segments.at(-1);
  if (fileName === undefined || !fileName.includes(".")) {
    return null;
  }

  const encodedPath = segments
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const assetUrl = new URL(encodedPath, clientDirectoryUrl);
  return assetUrl.href.startsWith(clientDirectoryUrl.href) ? assetUrl : null;
};

const withResponseHeaders = (
  response: Response,
  responseHeaders: HeadersInit | undefined,
): Response => {
  if (responseHeaders === undefined) {
    return response;
  }

  const headers = new Headers(response.headers);
  const additions = new Headers(responseHeaders);
  for (const [name, value] of additions) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

type CreateStartRuntimeOptions = {
  clientDirectoryUrl: URL;
  handler: unknown;
  healthPath?: string | undefined;
  immutableAssetPrefix?: string | undefined;
  responseHeaders?: HeadersInit | undefined;
};

export const createStartRuntime = ({
  clientDirectoryUrl,
  handler,
  healthPath = DEFAULT_HEALTH_PATH,
  immutableAssetPrefix = DEFAULT_IMMUTABLE_ASSET_PREFIX,
  responseHeaders,
}: CreateStartRuntimeOptions): StartFetchHandler => {
  requireFileDirectoryUrl(clientDirectoryUrl);
  if (!isStartFetchHandler(handler)) {
    throw new StartRuntimeError({
      code: "invalid-handler",
      message: "The TanStack Start server bundle must export a fetch handler.",
    });
  }

  return {
    async fetch(request) {
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname === healthPath) {
        return withResponseHeaders(
          new Response("ok", {
            headers: {
              "cache-control": "no-store",
              "content-type": "text/plain; charset=utf-8",
            },
          }),
          responseHeaders,
        );
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const assetUrl = resolveClientAssetUrl(requestUrl, clientDirectoryUrl);
        if (assetUrl !== null) {
          const asset = file(assetUrl);
          if (await asset.exists()) {
            const headers = new Headers({
              "cache-control": requestUrl.pathname.startsWith(
                immutableAssetPrefix,
              )
                ? IMMUTABLE_CACHE_CONTROL
                : REVALIDATED_CACHE_CONTROL,
            });
            if (asset.type) {
              headers.set("content-type", asset.type);
            }
            return withResponseHeaders(
              new Response(request.method === "HEAD" ? null : asset, {
                headers,
              }),
              responseHeaders,
            );
          }
        }
      }

      return withResponseHeaders(await handler.fetch(request), responseHeaders);
    },
  };
};

type ServerModuleFailure = {
  error: unknown;
  path: string;
};

const isModuleResolutionError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (("name" in error && error.name === "ResolveMessage") ||
    ("code" in error && error.code === "ERR_MODULE_NOT_FOUND") ||
    error instanceof SyntaxError);

const describeModuleFailure = ({ error, path }: ServerModuleFailure): string =>
  `${path}: ${error instanceof Error ? error.message : String(error)}`;

export type ServerModuleGraphVerification = {
  loadedModuleCount: number;
  toleratedFailures: readonly string[];
};

type VerifyServerModuleGraphOptions = {
  serverDirectoryUrl: URL;
};

export const verifyServerModuleGraph = async ({
  serverDirectoryUrl,
}: VerifyServerModuleGraphOptions): Promise<ServerModuleGraphVerification> => {
  requireFileDirectoryUrl(serverDirectoryUrl);
  const serverDirectoryPath = fileURLToPath(serverDirectoryUrl);
  const paths = await Array.fromAsync(
    new Bun.Glob("**/*.js").scan({
      cwd: serverDirectoryPath,
      onlyFiles: true,
    }),
  );
  paths.sort();
  if (paths.length === 0) {
    throw new StartRuntimeError({
      code: "empty-server-directory",
      message: "The server bundle directory contains no JavaScript modules.",
    });
  }

  const failures = (
    await Promise.all(
      paths.map(async (relativePath): Promise<ServerModuleFailure | null> => {
        try {
          await import(
            pathToFileURL(nodePath.join(serverDirectoryPath, relativePath)).href
          );
          return null;
        } catch (error) {
          return { error, path: relativePath };
        }
      }),
    )
  ).filter((failure) => failure !== null);
  const fatalFailures = failures.filter(({ error }) =>
    isModuleResolutionError(error),
  );
  if (fatalFailures.length > 0) {
    const descriptions = fatalFailures.map(describeModuleFailure);
    throw new StartRuntimeError({
      code: "server-module-resolution",
      failures: descriptions,
      message: `The server module graph failed to resolve:\n${descriptions.join("\n")}`,
    });
  }

  return {
    loadedModuleCount: paths.length - failures.length,
    toleratedFailures: failures.map(describeModuleFailure),
  };
};

type ServeStartRuntimeOptions = {
  fetch: StartFetchHandler["fetch"];
  hostname: string;
  idleTimeout?: number | undefined;
  port: number;
};

export const serveStartRuntime = ({
  fetch,
  hostname,
  idleTimeout,
  port,
}: ServeStartRuntimeOptions) =>
  serve({
    fetch,
    hostname,
    ...(idleTimeout === undefined ? {} : { idleTimeout }),
    port,
  });
