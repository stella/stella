import {
  CACHE_CONTROL_HEADER,
  NO_CACHE,
  PRIVATE_CACHE_CONTROL,
} from "@/api/http/cache";
import type { Middleware } from "@/api/http/route";

/** Bearer-authorized documents and refusals must never be cached or referred onward. */
export const invoiceLinkResponsePolicy: Middleware = async (context, inner) => {
  context.set.cache = NO_CACHE;
  context.set.privateOnly = true;
  context.set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
  context.set.headers["Referrer-Policy"] = "no-referrer";
  const response = await inner();
  response.headers.set(CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL);
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
};
