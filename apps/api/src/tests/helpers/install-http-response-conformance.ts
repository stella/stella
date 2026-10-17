import { panic } from "better-result";
import type { InternalRoute } from "elysia";

import { createRouteRegistryMatcher } from "@/api/lib/route-registry-matcher";

import {
  installElysiaResponseObserver,
  type ElysiaResponseApp,
} from "./elysia-response-observer";
import { recordResponseConformanceExecution } from "./response-conformance-execution-collector";
import {
  rethrowResponseConformanceFailure,
  setResponseConformanceRequestModels,
  getResponseConformanceRequestModels,
} from "./response-conformance-request-errors";
import { recordResponseConformanceViolation } from "./response-conformance-sink";
import { assertHttpResponseConformance } from "./response-conformance-validation";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const responseModels = (app: ElysiaResponseApp) =>
  Object.fromEntries(
    Object.entries(app.models)
      .filter(([name]) => name !== "modules")
      .map(([name, model]) => {
        if (!isRecord(model) || !("schema" in model)) {
          return panic("Elysia response model has no executable schema");
        }
        return [name, model["schema"]] satisfies readonly [string, unknown];
      }),
  );

type MatchedRegistry = {
  routes: readonly InternalRoute[];
  aot: boolean | undefined;
  strictPath: boolean | undefined;
  match: ReturnType<typeof createRouteRegistryMatcher>;
};

/** Observe test-created apps without importing the application/server graph. */
export const installHttpResponseConformance = () => {
  const registries = new WeakMap<ElysiaResponseApp, MatchedRegistry>();
  return installElysiaResponseObserver(
    async ({ app, request, response }) => {
      try {
        // Elysia can turn a factory observer throw into a response through onError.
        // The request-scoped failure survives that conversion and escapes here.
        rethrowResponseConformanceFailure(request);
        const routes = app.routes;
        let registry = registries.get(app);
        if (
          registry === undefined ||
          registry.aot !== app.config.aot ||
          registry.strictPath !== app.config.strictPath ||
          registry.routes.length !== routes.length ||
          registry.routes.some((route, index) => route !== routes.at(index))
        ) {
          registry = {
            routes: [...routes],
            aot: app.config.aot,
            strictPath: app.config.strictPath,
            match: createRouteRegistryMatcher({
              routes,
              staticRoutes: app.router.static,
              strictPath: app.config.strictPath,
              aot: app.config.aot,
            }),
          };
          registries.set(app, registry);
        }
        const route = registry.match(request);
        if (route === undefined) {
          return;
        }
        recordResponseConformanceExecution(
          "http",
          `${route.method} ${route.path}`,
        );
        const hooks: unknown = route.hooks;
        if (!isRecord(hooks)) {
          panic("Elysia route has no response hook metadata");
        }
        const schema = hooks["response"];
        await assertHttpResponseConformance({
          route: `${route.method} ${route.path}`,
          method: request.method,
          response,
          schema,
          handler: route.handler,
          models: getResponseConformanceRequestModels(request),
        });
      } catch (error) {
        recordResponseConformanceViolation(error);
        throw error;
      }
    },
    ({ app, request }) => {
      setResponseConformanceRequestModels(request, responseModels(app));
    },
  );
};
