import { apiPipeline } from "@/api/api-pipeline";
import { createHttpApp } from "@/api/http/app";
import type { RouteEntry } from "@/api/http/route";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";

/**
 * Serve some of the API's routes behind the API's own request pipeline, so a
 * test reaches them exactly as a client would, without the rest of the table.
 */
export const serveRoutesForTest = (routes: readonly RouteEntry[]): TestServer =>
  serveForTest(createHttpApp({ routes, middleware: apiPipeline }));
