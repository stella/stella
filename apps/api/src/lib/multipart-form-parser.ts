/**
 * Elysia's built-in `multipart/form-data` parser runs before route validation
 * and JSON-parses any field whose string value starts with `{` or `[`. A body
 * schema that types such a field as `t.String()` therefore rejects a correctly
 * typed request with a 422, and nothing in the types can show it: both the
 * TypeBox static type and the Eden client still say `string`.
 *
 * This parser replaces that behaviour with flat parsing: every field keeps the
 * exact string or file the client sent, a repeated key becomes an array, and
 * nothing is JSON-parsed. Handlers that expect JSON in a field parse it
 * themselves, where a malformed value is a handled 400 instead of a framework
 * 422.
 *
 * Nested key syntax (`a.b`, `a[0]`) is deliberately not expanded: Eden
 * serializes a body to flat field names (a nested value becomes one
 * JSON-stringified field), every multipart route here is reached that way, and
 * the census in `src/tests/security/multipart-json-fields.test.ts` posts
 * against the real schemas to keep it so.
 */

import { Elysia } from "elysia";

/** Keys that would walk up the prototype chain if written onto the body. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The form type `Request.formData()` actually resolves to, and its entries. */
type RequestFormData = Awaited<ReturnType<Request["formData"]>>;
type MultipartFormValue = ReturnType<RequestFormData["getAll"]>[number];

/**
 * The one method this module needs off a request. Reading the body through a
 * narrow port keeps the module honest about its dependency and sidesteps
 * undici's blanket "prefer a streaming parser" deprecation on `formData()`,
 * which does not apply here: this is the same buffered read Elysia's own
 * multipart parser performs, and per-field size limits live in the route
 * schemas.
 */
type MultipartRequest = { formData: () => Promise<RequestFormData> };

const readForm = async (request: MultipartRequest): Promise<RequestFormData> =>
  await request.formData();

export type MultipartFormBody = Record<
  string,
  MultipartFormValue | MultipartFormValue[]
>;

/** Flat `FormData` -> body object: values pass through untouched, and a key
 *  sent more than once collects into an array in wire order. */
export const parseMultipartForm = (
  form: RequestFormData,
): MultipartFormBody => {
  const fields = new Map<string, MultipartFormValue | MultipartFormValue[]>();

  for (const [key, value] of form.entries()) {
    if (DANGEROUS_KEYS.has(key)) {
      continue;
    }

    const existing = fields.get(key);
    if (existing === undefined) {
      fields.set(key, value);
      continue;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      continue;
    }
    fields.set(key, [existing, value]);
  }

  return Object.fromEntries(fields);
};

/**
 * Registers `parseMultipartForm` as the multipart parser for every route.
 *
 * The `none` parser is part of the mechanism, not a decoration. Elysia short
 * circuits a route that declares `parse: "none"` only while it is the route's
 * *first* parser; a global hook takes that slot, so `"none"` falls through to
 * the named-parser lookup, which has no entry for it and answers 400. Routes
 * that own their raw body (the mounted auth handler, the MCP transports)
 * depend on that declaration, so the plugin supplies the no-op the lookup
 * expects: returning `null` marks the body handled and leaves the request
 * stream unread.
 */
export const multipartFormParser = new Elysia({
  name: "multipart-form-parser",
})
  .parser("none", () => null)
  .onParse({ as: "global" }, async ({ request, contentType }) =>
    contentType.startsWith("multipart/form-data")
      ? parseMultipartForm(await readForm(request))
      : undefined,
  );
