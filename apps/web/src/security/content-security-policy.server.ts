import { panic, Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { sha256Base64 } from "@stll/sha256/bun";

import {
  buildContentSecurityPolicy,
  type ContentSecurityPolicyEnvironment,
  createContentSecurityPolicyNonce,
} from "./content-security-policy";

const requestNonce = new AsyncLocalStorage<string>();

export const getRequestNonce = (): string =>
  requestNonce.getStore() ?? panic("SSR requires a request CSP nonce");

type WithContentSecurityPolicyOptions = {
  environment: ContentSecurityPolicyEnvironment;
  fetchResponse: () => Promise<Response>;
};

export const withContentSecurityPolicy = async ({
  environment,
  fetchResponse,
}: WithContentSecurityPolicyOptions): Promise<Response> => {
  const nonce = createContentSecurityPolicyNonce();
  return await requestNonce.run(nonce, async () => {
    const response = await fetchResponse();
    if (
      response.headers
        .get("Content-Type")
        ?.split(";")
        .at(0)
        ?.trim()
        .toLowerCase() !== "text/html"
    ) {
      return response;
    }
    if (allowsSharedStorage(response.headers.get("Cache-Control"))) {
      return await withScriptHashPolicy(response, environment);
    }
    const headers = new Headers(response.headers);
    headers.set(
      "Content-Security-Policy",
      buildContentSecurityPolicy({ kind: "nonce", nonce }, environment),
    );
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  });
};

/**
 * A shared cache may store a response unless its Cache-Control says
 * `private` or `no-store`. The server sets Cache-Control on every document, so
 * a missing header only occurs outside it.
 */
const allowsSharedStorage = (cacheControl: string | null): boolean => {
  if (cacheControl === null) {
    return false;
  }
  const directives = new Set(
    cacheControl
      .split(",")
      .map((directive) => directive.split("=").at(0)?.trim().toLowerCase()),
  );
  return !directives.has("private") && !directives.has("no-store");
};

/**
 * A document a shared cache may store is sent to every viewer, so its policy
 * must not depend on a per-request nonce. The whole document is read first,
 * each inline script is admitted by its hash, and the nonce the renderer wrote
 * is removed from the markup. A body that fails part way is forwarded as far
 * as it was read and then fails again, so a cache still never stores it.
 */
const withScriptHashPolicy = async (
  response: Response,
  environment: ContentSecurityPolicyEnvironment,
): Promise<Response> => {
  const { bytes, failure } = await readBody(response.body);
  const hashes = new Set<string>();
  const html = await scriptHashRewriter(hashes)
    .transform(new Response(bytes))
    .text();
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.set(
    "Content-Security-Policy",
    buildContentSecurityPolicy(
      { kind: "hashes", hashes: [...hashes] },
      environment,
    ),
  );
  const encoded = new TextEncoder().encode(html);
  let delivered = false;
  // Erroring a stream discards what it still queues, so the failure is
  // raised only once the document bytes have been read.
  const body =
    failure === null
      ? encoded
      : new ReadableStream<Uint8Array>({
          pull: (controller) => {
            if (delivered) {
              controller.error(failure.error);
              return;
            }
            delivered = true;
            controller.enqueue(encoded);
          },
        });
  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

/** Every byte the body yields, and the error that ended it early, if any. */
const readBody = async (
  body: ReadableStream<Uint8Array> | null,
): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  failure: { error: unknown } | null;
}> => {
  const chunks: Uint8Array[] = [];
  let failure: { error: unknown } | null = null;
  if (body !== null) {
    const reader = body.getReader();
    try {
      for (;;) {
        const chunk = await Result.tryPromise({
          try: async () => await reader.read(),
          catch: (error) => error,
        });
        if (chunk.isErr()) {
          failure = { error: chunk.error };
          break;
        }
        if (chunk.value.done) {
          break;
        }
        chunks.push(chunk.value.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, failure };
};

const EXECUTABLE_SCRIPT_TYPE =
  /^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/u;

/** A script element without `type`, or with a JavaScript one, runs. */
const isExecutableScriptType = (type: string | null): boolean => {
  const normalized = type?.trim().toLowerCase() ?? "";
  return normalized === "" || EXECUTABLE_SCRIPT_TYPE.test(normalized);
};

/**
 * The CSP hash of an inline script: base64 SHA-256 of its UTF-8 text after the
 * HTML parser's newline normalization.
 */
const scriptHash = (text: string): string =>
  sha256Base64(text.replaceAll(/\r\n?/gu, "\n"));

const scriptHashRewriter = (hashes: Set<string>): HTMLRewriter => {
  let inlineScript: string[] | null = null;
  return new HTMLRewriter()
    .on("meta[property='csp-nonce']", {
      element: (element) => {
        element.remove();
      },
    })
    .on("[nonce]", {
      element: (element) => {
        element.removeAttribute("nonce");
      },
    })
    .on("script", {
      element: (element) => {
        if (
          element.hasAttribute("src") ||
          !isExecutableScriptType(element.getAttribute("type"))
        ) {
          inlineScript = null;
          return;
        }
        const text: string[] = [];
        inlineScript = text;
        element.onEndTag(() => {
          hashes.add(scriptHash(text.join("")));
          inlineScript = null;
        });
      },
      text: (chunk) => {
        inlineScript?.push(chunk.text);
      },
    });
};
