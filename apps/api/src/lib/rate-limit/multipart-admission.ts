import { Result } from "better-result";

import type { Middleware } from "@/api/http/route";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import {
  actionSizeErrorResponse,
  boundActionRequest,
} from "@/api/lib/rate-limit/action-size-limits";

/** Largest accepted file plus bounded multipart headers and scalar fields. */
export const MULTIPART_REQUEST_MAX_BYTES =
  FILE_SIZE_LIMIT_BYTES.document + 1024 * 1024;

const isMultipartFormDataRequest = (request: Request): boolean =>
  request.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("multipart/form-data") === true;

export const admitMultipartRequest = async (request: Request) =>
  isMultipartFormDataRequest(request)
    ? (await boundActionRequest(request, MULTIPART_REQUEST_MAX_BYTES)).map(
        ({ request: bounded }) => bounded,
      )
    : Result.ok(request);

/**
 * Bounds every multipart body before a route parses it, whatever the route's
 * access or the action size policy: the form is read into memory whole.
 */
export const multipartAdmission: Middleware = async (ctx, inner) => {
  const admitted = await admitMultipartRequest(ctx.request);
  if (Result.isError(admitted)) {
    return actionSizeErrorResponse(admitted.error);
  }
  return await inner({ ...ctx, request: admitted.value });
};
