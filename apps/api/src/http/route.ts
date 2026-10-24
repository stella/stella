import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { HttpStringInput } from "@stll/api-contract/http-input";

import type { CachePolicy } from "@/api/http/cache";
import type { RequestContext } from "@/api/http/context";
import type { BodyMode } from "@/api/http/input";

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Any Standard Schema validator. The HTTP layer depends on the interface
 * only; the schemas themselves are written with valibot.
 */
export type AnySchema = StandardSchemaV1;

/** Responses a route declares, by status. */
export type ResponseSchemas = Readonly<Partial<Record<number, AnySchema>>>;

/**
 * Path segments and query values arrive as strings, so their schemas must
 * read strings: a number or boolean is parsed by the schema itself
 * (`numberFromString`, `booleanFromString`, `arrayFromQuery`).
 */
type WireSchema<TInput> = StandardSchemaV1<TInput, unknown>;

/** How a route reads and checks its input and answer. */
export type RouteConfig = {
  readonly params?: WireSchema<Readonly<Record<string, string>>>;
  readonly query?: WireSchema<HttpStringInput>;
  readonly body?: AnySchema;
  /** Request headers the route requires, keyed by lower-cased name. */
  readonly headers?: AnySchema;
  readonly response?: ResponseSchemas;
  /** How the body is read; by content type unless the route says otherwise. */
  readonly bodyMode?: BodyMode;
};

/**
 * Who may call a route, decided before its input is read.
 *
 * - `public`: anyone; the handler sees no caller.
 * - `token`: anyone holding the credential the route checks on the raw request.
 * - `session`: a signed-in account with a live stored session.
 * - `member`: a signed-in member of the active organization.
 * - `workspace`: a member with access to the matter named by the
 *   `:workspaceId` path segment, in the status its config admits.
 */
export type RouteAccess =
  "public" | "token" | "session" | "member" | "workspace";

/**
 * One stage of the pipeline: answer the request, or pass it on. A stage may
 * pass inner stages a replacement context, for example the same request with
 * its body bounded; stages outside it keep seeing the original.
 */
export type Middleware = (
  ctx: RequestContext,
  inner: (replacement?: RequestContext) => Promise<Response>,
) => Promise<Response>;

/** A matched request as the route's own code receives it: nothing decoded yet. */
export type RouteRequest = {
  readonly ctx: RequestContext;
  /** The pattern the route is mounted at (`/v1/files/:fileId`). */
  readonly route: string;
  /**
   * Read the body as the route's body mode says. Called after the caller is
   * known, so an anonymous request is refused before its body is parsed.
   */
  readonly readBody: () => Promise<unknown>;
};

/**
 * A route's whole behaviour: who may call it, how its input decodes, and its
 * answer. The safe handler factories in `lib/api-handlers.ts` build it where
 * the handler's context type is known, so nothing here needs to know it.
 */
/**
 * A definition's config: the slots the HTTP layer reads, beside whatever else
 * its factory records (write contract, MCP exposure, permissions). The open
 * remainder is what lets a config that reads no input (a token or session
 * route) still be a route config; each factory keeps its own config exact.
 */
type RouteDefinitionConfig = RouteConfig & Readonly<Record<string, unknown>>;

export type RouteDefinition = {
  readonly config: RouteDefinitionConfig;
  readonly access: RouteAccess;
  /** How long a successful answer may be cached; absent means not at all. */
  readonly cache?: CachePolicy;
  /** `own`: the route answers CORS itself; the API's credentialed CORS stays off. */
  readonly cors?: "own";
  readonly run: (request: RouteRequest) => Promise<unknown>;
};

/** One mounted route: plain data that tooling and censuses read directly. */
export type RouteEntry = {
  readonly method: HttpMethod;
  /** Full path pattern, prefix included (`/v1/files/:fileId`). */
  readonly path: string;
  /** Stages that run before this route only, outermost first. */
  readonly middleware: readonly Middleware[];
  readonly definition: RouteDefinition;
};

/** A path's routes by method, in the shape `Bun.serve` routes take. */
type MethodRoutes = Readonly<Partial<Record<HttpMethod, RouteDefinition>>>;

/** Paths to their routes, as `Bun.serve({ routes })` spells them. */
export type RouteTable = Readonly<Record<string, MethodRoutes>>;

/**
 * Mounted routes. At run time the entries; for the compiler also every full
 * path's method routes with their precise definitions (`TRoutes`), which the
 * browser client's types are printed from (`src/web-contract.ts`).
 *
 * Compose groups with `routes()` and `mount()` only: spreading one into an
 * array keeps its entries but drops `TRoutes`, and the contract then reports
 * the untyped group instead of serving its routes untyped.
 */
export type RouteGroup<TRoutes = unknown> = RouteEntry[] & {
  /** Compile time only; never set at run time. */
  readonly "~routes"?: TRoutes;
};

/**
 * Stands in for routes the compiler cannot read. The web contract printer
 * refuses any printout that contains this marker.
 */
type UntypedRoutes<TReason extends string> = Readonly<
  Record<`~routeTypeError: ${TReason}`, Record<never, never>>
>;

type TrimTrailingSlash<TPath extends string> = TPath extends `${infer THead}/`
  ? THead
  : TPath;

/** `joinPath` on literal types: `JoinPath<"/v1", "/files">` is `"/v1/files"`. */
type JoinPath<TPrefix extends string, TPath extends string> = TPrefix extends ""
  ? TPath
  : TPath extends "/" | ""
    ? TPrefix
    : `${TrimTrailingSlash<TPrefix>}${TPath extends `/${string}` ? TPath : `/${TPath}`}`;

/** A table's method routes keyed by their full path under `TPrefix`. */
export type PrefixRoutes<
  TTable,
  TPrefix extends string,
> = string extends TPrefix
  ? UntypedRoutes<"a mount prefix is not a literal string, declare it as const">
  : string extends keyof TTable
    ? UntypedRoutes<"a route table has a non-literal path, declare it as const">
    : {
        readonly [
          TPath in keyof TTable & string as JoinPath<TPrefix, TPath>
        ]: TTable[TPath];
      };

/** The full-path method routes a group carries. */
export type RoutesOf<TGroup> =
  TGroup extends RouteGroup<infer TRoutes>
    ? unknown extends TRoutes
      ? UntypedRoutes<"a route group was spread into an array, compose groups with mount()">
      : TRoutes
    : never;

type UnionToIntersection<TUnion> = (
  TUnion extends unknown ? (value: TUnion) => void : never
) extends (value: infer TIntersection) => void
  ? TIntersection
  : never;

/** The method routes of several groups as one table. */
export type MergedRoutes<TGroups extends readonly RouteGroup[]> =
  UnionToIntersection<RoutesOf<TGroups[number]>>;

export type MountOptions<TPrefix extends string = string> = {
  /** Prepended to every path. */
  readonly prefix?: TPrefix;
  /** Runs before every route mounted here, outermost first. */
  readonly middleware?: readonly Middleware[];
};

const joinPath = (prefix: string, path: string): string => {
  if (prefix === "") {
    return path;
  }
  if (path === "/" || path === "") {
    return prefix;
  }
  return `${prefix.replace(/\/$/u, "")}${path.startsWith("/") ? path : `/${path}`}`;
};

/**
 * A group loaded only in some runtimes (`undefined` elsewhere): no routes where
 * it is absent, and its routes' types in every runtime. `group ?? emptyGroup`
 * would lose them, since a typed group is a subtype of an empty one and the
 * union reduces to the empty group.
 */
export const servedIfLoaded = <TRoutes>(
  group: RouteGroup<TRoutes> | undefined,
): RouteGroup<TRoutes> => group ?? [];

/** The routes of a table, mounted under a prefix and middleware. */
export const routes = <
  const TTable extends RouteTable,
  const TPrefix extends string = "",
>(
  table: TTable,
  options: MountOptions<TPrefix> = {},
): RouteGroup<PrefixRoutes<TTable, TPrefix>> => {
  const prefix: string = options.prefix ?? "";
  const middleware = options.middleware ?? [];
  const source: RouteTable = table;
  return Object.entries(source).flatMap(([path, methods]) =>
    HTTP_METHODS.flatMap((method) => {
      const definition = methods[method];
      return definition === undefined
        ? []
        : [{ method, path: joinPath(prefix, path), middleware, definition }];
    }),
  );
};

/** Already-built groups, mounted again under a prefix and middleware. */
export const mount = <
  const TGroups extends readonly RouteGroup[],
  const TPrefix extends string = "",
>(
  groups: TGroups,
  options: MountOptions<TPrefix> = {},
): RouteGroup<PrefixRoutes<MergedRoutes<TGroups>, TPrefix>> => {
  const prefix: string = options.prefix ?? "";
  const middleware = options.middleware ?? [];
  return groups.flat().map((entry) => ({
    ...entry,
    path: joinPath(prefix, entry.path),
    middleware: [...middleware, ...entry.middleware],
  }));
};
