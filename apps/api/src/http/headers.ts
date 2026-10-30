import { applyResponseHeaders } from "@/api/http/context";

/**
 * `response` with `headers` added in place, returned for chaining. Headers
 * the response already carries win unless `overwrite` is set; every
 * `set-cookie` is appended.
 *
 * A stage edits the answer it is handed rather than copying it: every
 * response a stage sees was built for this request (`toResponse` copies a
 * handler's `Response` into a fresh one, and a stage that answers itself
 * builds its own), and Bun keeps every `Response`'s headers mutable, a
 * fetched answer's included.
 */
export const setResponseHeaders = (
  response: Response,
  headers: Readonly<Record<string, string>>,
  { overwrite }: { readonly overwrite: boolean },
): Response => {
  applyResponseHeaders(response.headers, headers, { overwrite });
  return response;
};
