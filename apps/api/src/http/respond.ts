import { panic } from "better-result";

import { applyResponseHeaders } from "@/api/http/context";
import type { ResponseSet } from "@/api/http/context";
import { unwrapStatus } from "@/api/http/status";

const DEFAULT_STATUS = 200;

type ResponseBody = ConstructorParameters<typeof Response>[0];

const bodyFor = (value: unknown, headers: Headers): ResponseBody => {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json;charset=utf-8");
    }
    return "null";
  }
  if (typeof value === "string") {
    if (!headers.has("content-type")) {
      headers.set("content-type", "text/plain;charset=utf-8");
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    if (!headers.has("content-type")) {
      headers.set("content-type", "text/plain;charset=utf-8");
    }
    return String(value);
  }
  if (value instanceof Blob) {
    if (value.type !== "" && !headers.has("content-type")) {
      headers.set("content-type", value.type);
    }
    return value;
  }
  if (
    value instanceof ReadableStream ||
    value instanceof FormData ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    // A view may sit on a shared buffer, which a body cannot carry; copy it out.
    const bytes = new Uint8Array(value.byteLength);
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return bytes;
  }
  if (typeof value === "object") {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json;charset=utf-8");
    }
    return JSON.stringify(value);
  }
  return panic(
    `A handler answered with a value the HTTP layer cannot send: ${Object.prototype.toString.call(value)}`,
  );
};

/**
 * The `Response` for a handler's answer and the status and headers the
 * request accumulated.
 *
 * A returned `Response` keeps its own status unless it is a plain 200, which
 * the accumulated status overrides, and keeps every header it set; the
 * accumulated headers fill the rest and every `set-cookie` is kept.
 */
export const toResponse = (answer: unknown, set: ResponseSet): Response => {
  const { value, code } = unwrapStatus(answer);
  const accumulatedStatus = code ?? set.status ?? DEFAULT_STATUS;

  if (value instanceof Response) {
    const headers = new Headers(value.headers);
    applyResponseHeaders(headers, set.headers, { overwrite: false });
    return new Response(value.body, {
      status:
        value.status === DEFAULT_STATUS ? accumulatedStatus : value.status,
      statusText: value.statusText,
      headers,
    });
  }

  const headers = new Headers();
  applyResponseHeaders(headers, set.headers, { overwrite: true });
  return new Response(bodyFor(value, headers), {
    status: accumulatedStatus,
    headers,
  });
};
