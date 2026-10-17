import { panic } from "@stll/errors";
import type { RequestExceptionScope } from "@stll/errors";

export type ScopedResponseObserver = (context: {
  response: Response;
  scope: RequestExceptionScope;
}) => void | Promise<void>;

const REQUEST_SCOPE = Symbol("stella.request-scope");
const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);
const BODYLESS_METHODS = new Set(["get", "head"]);

const scopedOptions = (input: unknown, scope: RequestExceptionScope) => {
  const options = typeof input === "object" && input !== null ? input : {};
  const fetch = "fetch" in options ? options.fetch : undefined;
  return {
    ...options,
    fetch: {
      ...(typeof fetch === "object" && fetch !== null ? fetch : {}),
      [REQUEST_SCOPE]: scope,
    },
  };
};

type ScopedTransportOptions = {
  fetcher: typeof globalThis.fetch;
  observer: ScopedResponseObserver;
};

/** Carry declared proxy segments through transport without sending metadata. */
export const createScopedResponseTransport = ({
  fetcher,
  observer,
}: ScopedTransportOptions) => {
  const observeFetch = Object.assign(
    async (
      input: Parameters<typeof fetcher>[0],
      init: Parameters<typeof fetcher>[1],
    ) => {
      if (init === undefined || !(REQUEST_SCOPE in init)) {
        return await fetcher(input, init);
      }
      const { [REQUEST_SCOPE]: scope, ...fetchInit } = init;
      if (
        typeof scope !== "object" ||
        scope === null ||
        !("type" in scope) ||
        scope.type !== "request" ||
        !("method" in scope) ||
        typeof scope.method !== "string" ||
        !("routeTemplate" in scope) ||
        typeof scope.routeTemplate !== "string"
      ) {
        return panic("Invalid scoped API request metadata");
      }
      const response = await fetcher(input, fetchInit);
      await observer({
        response: response.clone(),
        scope: {
          type: "request",
          method: scope.method,
          routeTemplate: scope.routeTemplate,
        },
      });
      return response;
    },
    { preconnect: fetcher.preconnect },
  );
  const wrap = <TClient extends object>(
    client: TClient,
    segments: readonly string[],
  ): TClient =>
    new Proxy(client, {
      get(target, property) {
        const next: unknown = Reflect.get(target, property);
        if (typeof next !== "function" || typeof property !== "string") {
          return next;
        }
        return wrap(next, [...segments, property]);
      },
      apply(target, thisArg, args: unknown[]) {
        if (typeof target !== "function") {
          return panic("API proxy target must be callable");
        }
        const method = segments.at(-1);
        if (method !== undefined && HTTP_METHODS.has(method)) {
          const scope = {
            type: "request",
            method: method.toUpperCase(),
            routeTemplate: `/${segments.slice(0, -1).join("/")}`,
          } as const;
          const scopedArgs = BODYLESS_METHODS.has(method)
            ? [scopedOptions(args.at(0), scope)]
            : [args.at(0), scopedOptions(args.at(1), scope)];
          const response: unknown = Reflect.apply(target, thisArg, scopedArgs);
          return response;
        }
        const result: unknown = Reflect.apply(target, thisArg, args);
        const parameter = args.at(0);
        if (
          typeof result !== "function" ||
          typeof parameter !== "object" ||
          parameter === null
        ) {
          return result;
        }
        return wrap(result, [
          ...segments,
          ...Object.keys(parameter).map((key) => `:${key}`),
        ]);
      },
    });
  return {
    fetcher: observeFetch,
    wrapClient: <TClient extends object>(client: TClient) => wrap(client, []),
  };
};
