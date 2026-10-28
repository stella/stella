/**
 * The typed browser client for the Stella API. It walks the printed route
 * tree (`apps/web/src/generated/api-routes.gen.ts`): property access names a
 * path segment, a call with one value names a path parameter, and a call of a
 * method name sends the request.
 *
 * ```ts
 * const { data, error } = await api
 *   .workspaces({ workspaceId })
 *   .files.get({ query: { limit: 50 } });
 * ```
 *
 * Path, query and form values are written as the API reads them back
 * (`toWireInput`): text as is, numbers and booleans as their literal, lists
 * as repeated keys, documents as JSON. Answers decode by content type.
 */
import { panic, Result } from "better-result";

import { toWireInput } from "@stll/api-contract/http-input";

import type { ScopedResponseObserver } from "./scoped-response";

export type { ScopedResponse } from "./scoped-response";

const METHOD_NAMES = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const;
type MethodName = (typeof METHOD_NAMES)[number];

const isMethodName = (segment: string): segment is MethodName =>
  METHOD_NAMES.some((method) => method === segment);

/** Methods whose request carries no body; their only argument is the options. */
type BodilessMethodName = "get" | "head" | "options";

const isBodilessMethod = (method: MethodName): boolean =>
  method === "get" || method === "head" || method === "options";

// --- Types -------------------------------------------------------------------

/** One route as the printed route tree describes it. */
export type RouteShape = {
  body: unknown;
  params: unknown;
  query: unknown;
  headers: unknown;
  response: unknown;
};

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;

type SuccessKey<TResponses> = Extract<keyof TResponses, SuccessStatus>;

type SuccessData<TResponses> = [SuccessKey<TResponses>] extends [never]
  ? unknown
  : TResponses[SuccessKey<TResponses>];

type ErrorKey<TResponses> = Exclude<keyof TResponses & number, SuccessStatus>;

/** A refused request: its status and decoded body, by the statuses the route declares. */
export type ApiError<TResponses> = [ErrorKey<TResponses>] extends [never]
  ? { readonly status: number; readonly value: unknown }
  : {
      [TStatus in ErrorKey<TResponses>]: {
        readonly status: TStatus;
        readonly value: TResponses[TStatus];
      };
    }[ErrorKey<TResponses>];

/** What every request resolves to: the decoded answer, or the refusal. */
export type ApiResult<TResponses> =
  | {
      readonly data: SuccessData<TResponses>;
      readonly error: null;
      readonly status: number;
      readonly response: Response;
      readonly headers: Headers;
    }
  | {
      readonly data: null;
      readonly error: ApiError<TResponses>;
      readonly status: number;
      readonly response: Response;
      readonly headers: Headers;
    };

type HeaderValues = Readonly<Record<string, string | undefined>>;

type NoOptions = Record<never, never>;

type QueryOption<TQuery> = unknown extends TQuery
  ? { readonly query?: Readonly<Record<string, unknown>> }
  : NoOptions extends TQuery
    ? { readonly query?: TQuery }
    : { readonly query: TQuery };

type HeadersOption<THeaders> = unknown extends THeaders
  ? { readonly headers?: HeaderValues }
  : NoOptions extends THeaders
    ? { readonly headers?: THeaders & HeaderValues }
    : { readonly headers: THeaders & HeaderValues };

/** Per-request options: the route's query and headers, and fetch settings. */
export type RequestOptions<TRoute extends RouteShape> = QueryOption<
  TRoute["query"]
> &
  HeadersOption<TRoute["headers"]> & {
    readonly fetch?: RequestInit & { readonly timeoutMs?: number };
  };

type OptionsArgs<TRoute extends RouteShape> =
  NoOptions extends RequestOptions<TRoute>
    ? [options?: RequestOptions<TRoute>]
    : [options: RequestOptions<TRoute>];

type BodyArgs<TRoute extends RouteShape> =
  NoOptions extends RequestOptions<TRoute>
    ? undefined extends TRoute["body"]
      ? [body?: TRoute["body"], options?: RequestOptions<TRoute>]
      : [body: TRoute["body"], options?: RequestOptions<TRoute>]
    : [body: TRoute["body"], options: RequestOptions<TRoute>];

type MethodCall<TName extends MethodName, TRoute extends RouteShape> = (
  ...args: TName extends BodilessMethodName
    ? OptionsArgs<TRoute>
    : BodyArgs<TRoute>
) => Promise<ApiResult<TRoute["response"]>>;

type ParamKey<TNode> = Extract<keyof TNode, `:${string}`>;

type ParamName<TKey> = TKey extends `:${infer TName}` ? TName : never;

/** A path parameter's value; a number is written as its literal. */
type PathValue = string | number;

type UnionToIntersection<TUnion> = (
  TUnion extends unknown ? (value: TUnion) => void : never
) extends (value: infer TIntersection) => void
  ? TIntersection
  : never;

type ParamCalls<TNode> = UnionToIntersection<
  {
    [TKey in ParamKey<TNode>]: (
      params: Readonly<Record<ParamName<TKey>, PathValue>>,
    ) => ApiClient<TNode[TKey]>;
  }[ParamKey<TNode>]
>;

/** The client for a route tree node: its segments, methods and parameters. */
export type ApiClient<TNode> = {
  readonly [
    TKey in Exclude<keyof TNode & string, ParamKey<TNode>>
  ]: TKey extends MethodName
    ? TNode[TKey] extends RouteShape
      ? MethodCall<TKey, TNode[TKey]>
      : ApiClient<TNode[TKey]>
    : ApiClient<TNode[TKey]>;
} & ParamCalls<TNode>;

type MaybePromise<TValue> = TValue | Promise<TValue>;

export type ApiClientOptions = {
  /** Observes the same unread response with its declared route, before decoding. */
  readonly onScopedResponse?: ScopedResponseObserver;
  /** Fetch settings every request starts from; credentials default to `include`. */
  readonly fetch?: RequestInit;
  /** Maximum request duration in milliseconds; a per-request value overrides it. */
  readonly timeoutMs?: number;
  /** Sends the request; `globalThis.fetch` when absent. */
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  /** Headers every request carries, or a function computing them per request. */
  readonly headers?:
    | HeaderValues
    | ((path: string, init: RequestInit) => MaybePromise<HeaderValues>);
  /** Runs before each request is sent; a returned promise is awaited. */
  readonly onRequest?: (path: string, init: RequestInit) => unknown;
  /**
   * Observes each response before it is decoded. It must leave the body
   * unread (read a `clone()`): the client decodes it afterwards.
   */
  readonly onResponse?: (response: Response) => unknown;
};

// --- Request -----------------------------------------------------------------

type ClientConfig = {
  readonly origin: string;
  readonly options: ApiClientOptions;
};

type ClientPath = {
  readonly segments: readonly string[];
  readonly template: readonly string[];
};

type CallOptions = {
  readonly query: unknown;
  readonly headers: unknown;
  readonly fetch: (RequestInit & { readonly timeoutMs?: number }) | undefined;
};

const readRequestInit = (
  value: unknown,
): (RequestInit & { readonly timeoutMs?: number }) | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const init: RequestInit & { readonly timeoutMs?: number } = value;
  return init;
};

const readCallOptions = (value: unknown): CallOptions => {
  if (typeof value !== "object" || value === null) {
    return { query: undefined, headers: undefined, fetch: undefined };
  }
  return {
    query: Reflect.get(value, "query"),
    headers: Reflect.get(value, "headers"),
    fetch: readRequestInit(Reflect.get(value, "fetch")),
  };
};

/** Appends a `toWireInput` record: one entry per value, a list as repeated keys. */
const appendWireValues = (
  target: { append: (name: string, value: string) => void },
  values: unknown,
): void => {
  if (typeof values !== "object" || values === null) {
    return;
  }
  const entries: [string, unknown][] = Object.entries(values);
  for (const [name, value] of entries) {
    if (typeof value === "string") {
      target.append(name, value);
      continue;
    }
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      for (const item of items) {
        if (typeof item === "string") {
          target.append(name, item);
        }
      }
    }
  }
};

const queryString = (query: unknown): string => {
  const search = new URLSearchParams();
  appendWireValues(search, toWireInput(query));
  const encoded = search.toString();
  return encoded === "" ? "" : `?${encoded}`;
};

const setHeaders = (target: Headers, values: unknown): void => {
  if (typeof values !== "object" || values === null) {
    return;
  }
  const entries: [string, unknown][] = Object.entries(values);
  for (const [name, value] of entries) {
    if (typeof value === "string") {
      target.set(name, value);
    }
  }
};

const isBlobList = (value: unknown): boolean =>
  Array.isArray(value) && value.some((item) => item instanceof Blob);

/** A record carrying a file at its top level is sent as a multipart form. */
const hasFile = (body: object): boolean =>
  Object.values(body).some(
    (value) => value instanceof Blob || isBlobList(value),
  );

/** Files are appended as they are; every other value as its wire string. */
const toFormData = (body: object): FormData => {
  const form = new FormData();
  const fields: [string, unknown][] = [];
  const entries: [string, unknown][] = Object.entries(body);
  for (const [name, value] of entries) {
    if (value instanceof Blob) {
      form.append(name, value);
      continue;
    }
    if (!Array.isArray(value)) {
      fields.push([name, value]);
      continue;
    }
    const items: readonly unknown[] = value;
    const rest: unknown[] = [];
    for (const item of items) {
      if (item instanceof Blob) {
        form.append(name, item);
      } else {
        rest.push(item);
      }
    }
    if (rest.length > 0) {
      fields.push([name, rest]);
    }
  }
  appendWireValues(form, toWireInput(Object.fromEntries(fields)));
  return form;
};

type EncodedBody = {
  readonly body: BodyInit | undefined;
  /** The content type to declare; `undefined` lets fetch derive it. */
  readonly contentType: string | undefined;
};

const encodeBody = (body: unknown): EncodedBody => {
  if (body === undefined) {
    return { body: undefined, contentType: undefined };
  }
  if (typeof body === "string") {
    return { body, contentType: "text/plain;charset=utf-8" };
  }
  if (
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    body instanceof ReadableStream
  ) {
    return { body, contentType: undefined };
  }
  if (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    hasFile(body)
  ) {
    return { body: toFormData(body), contentType: undefined };
  }
  return { body: JSON.stringify(body), contentType: "application/json" };
};

// --- Response ----------------------------------------------------------------

const mediaType = (response: Response): string =>
  (response.headers.get("content-type") ?? "")
    .split(";", 1)
    .at(0)
    ?.trim()
    .toLowerCase() ?? "";

/**
 * The answer's body by its content type: JSON parsed, text as a string, an
 * event stream unread, `application/octet-stream` as an `ArrayBuffer`, any
 * other type as a `Blob`. A response without a body decodes to `undefined`.
 */
const decodeBody = async (response: Response): Promise<unknown> => {
  if (response.body === null) {
    return undefined;
  }
  const type = mediaType(response);
  if (type === "text/event-stream") {
    return response.body;
  }
  if (type === "application/json" || type.endsWith("+json")) {
    const text = await response.text();
    if (text === "") {
      return undefined;
    }
    const parsed = Result.try((): unknown => JSON.parse(text));
    if (parsed.isOk()) {
      return parsed.value;
    }
    // A refusal's body is kept as sent; a success must be the declared JSON.
    return response.ok
      ? panic(
          `The API answered ${String(response.status)} with malformed JSON`,
          parsed.error,
        )
      : text;
  }
  if (type === "" || type.startsWith("text/")) {
    return await response.text();
  }
  if (type === "application/octet-stream") {
    return await response.arrayBuffer();
  }
  return await response.blob();
};

// --- Client ------------------------------------------------------------------

const send = async (
  config: ClientConfig,
  clientPath: ClientPath,
  method: MethodName,
  args: readonly unknown[],
): Promise<unknown> => {
  const bodiless = isBodilessMethod(method);
  const options = readCallOptions(bodiless ? args[0] : args[1]);
  const encoded = bodiless
    ? { body: undefined, contentType: undefined }
    : encodeBody(args[0]);
  const path = `/${clientPath.segments.join("/")}`;
  const { fetch: clientFetch, headers: clientHeaders } = config.options;

  const headers = new Headers(clientFetch?.headers);
  setHeaders(headers, options.fetch?.headers);
  const init: RequestInit = {
    ...clientFetch,
    ...options.fetch,
    credentials:
      options.fetch?.credentials ?? clientFetch?.credentials ?? "include",
    method: method.toUpperCase(),
    headers,
    ...(encoded.body === undefined ? {} : { body: encoded.body }),
  };
  const timeoutMs = options.fetch?.timeoutMs ?? config.options.timeoutMs;
  if (timeoutMs !== undefined) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    init.signal =
      init.signal === undefined || init.signal === null
        ? timeoutSignal
        : AbortSignal.any([init.signal, timeoutSignal]);
  }
  setHeaders(
    headers,
    typeof clientHeaders === "function"
      ? await clientHeaders(path, init)
      : clientHeaders,
  );
  setHeaders(headers, options.headers);
  if (encoded.contentType !== undefined && !headers.has("content-type")) {
    headers.set("content-type", encoded.contentType);
  }

  await config.options.onRequest?.(path, init);
  const url = `${config.origin}${path}${queryString(options.query)}`;
  const response = await (config.options.fetcher === undefined
    ? globalThis.fetch(url, init)
    : config.options.fetcher(url, init));
  await config.options.onScopedResponse?.({
    response,
    scope: {
      type: "request",
      method: method.toUpperCase(),
      routeTemplate: `/${clientPath.template.join("/")}`,
    },
  });
  await config.options.onResponse?.(response);

  const value = await decodeBody(response);
  const transport = {
    status: response.status,
    response,
    headers: response.headers,
  };
  return response.ok
    ? { data: value, error: null, ...transport }
    : {
        data: null,
        error: { status: response.status, value },
        ...transport,
      };
};

/** A path parameter call names one value: `workspaces({ workspaceId })`. */
const pathSegment = (params: unknown) => {
  if (typeof params !== "object" || params === null) {
    return panic(
      "A path parameter takes one named value, such as { workspaceId }",
    );
  }
  const entries: [string, unknown][] = Object.entries(params);
  const entry = entries.at(0);
  const value = entry?.[1];
  if (
    entry === undefined ||
    entries.length !== 1 ||
    (typeof value !== "string" && typeof value !== "number")
  ) {
    return panic(
      "A path parameter takes exactly one string or number, such as { workspaceId }",
    );
  }
  return { value: encodeURIComponent(String(value)), template: `:${entry[0]}` };
};

const node = (config: ClientConfig, path: ClientPath): unknown =>
  new Proxy(() => undefined, {
    get: (_target, property) =>
      // `then` is read by `await`; a client node is never a promise.
      typeof property === "string" && property !== "then"
        ? node(config, {
            segments: [...path.segments, property],
            template: [...path.template, property],
          })
        : undefined,
    apply: (_target, _receiver, args: readonly unknown[]) => {
      const last = path.segments.at(-1);
      if (last !== undefined && isMethodName(last)) {
        return send(
          config,
          {
            segments: path.segments.slice(0, -1),
            template: path.template.slice(0, -1),
          },
          last,
          args,
        );
      }
      const segment = pathSegment(args.at(0));
      return node(config, {
        segments: [...path.segments, segment.value],
        template: [...path.template, segment.template],
      });
    },
  });

/**
 * A client for the route tree `TRoutes`, sending to `origin` (no trailing
 * slash needed).
 */
export function createApiClient<TRoutes>(
  origin: string,
  options?: ApiClientOptions,
): ApiClient<TRoutes>;
// The client is a proxy over the path it has walked; the overload above is
// the type the route tree gives it.
export function createApiClient(
  origin: string,
  options: ApiClientOptions = {},
): unknown {
  return node(
    { origin: withoutTrailingSlashes(origin), options },
    { segments: [], template: [] },
  );
}

// A scan from the end, not `/\/+$/`: that pattern retries from every slash in
// a run that ends before the string does.
function withoutTrailingSlashes(origin: string): string {
  let end = origin.length;
  while (end > 0 && origin.at(end - 1) === "/") {
    end -= 1;
  }
  return origin.slice(0, end);
}
