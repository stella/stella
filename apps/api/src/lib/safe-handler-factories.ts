// The safe-handler factories and the scope each one gives its handler.
//
// Every guard that recognises a factory by name derives its list from this
// map: endpoint discovery, the route-file and public-route lint rules, and the
// retention census. The module imports nothing so the oxlint plugin project,
// the API scripts and tests can all load it. `safe-handler-factories.type-test.ts`
// binds its keys to the factories `api-handlers.ts` and `public-subject.ts`
// export, and `safe-handler-factories.test.ts` to every factory defined
// elsewhere in the API source.

export const HANDLER_KINDS = [
  "workspace",
  "root",
  "session",
  "token",
  "public",
] as const;
export type HandlerKind = (typeof HANDLER_KINDS)[number];

/**
 * Who the handler's context vouches for: a caller the framework
 * authenticated, a caller the handler authorizes itself from a token, or
 * nobody.
 */
type HandlerContextTrust = "authenticated" | "self-authorized" | "anonymous";

const API_HANDLERS_MODULE = "@/api/lib/api-handlers";
const PUBLIC_SUBJECT_MODULE =
  "@/api/handlers/case-law/decisions/public-subject";

type SafeHandlerScope = {
  kind: HandlerKind;
  context: HandlerContextTrust;
  /** The import specifier that defines the factory; a same-named import from elsewhere is not it. */
  module: typeof API_HANDLERS_MODULE | typeof PUBLIC_SUBJECT_MODULE;
};

export const SAFE_HANDLER_FACTORIES = {
  createSafeHandler: {
    kind: "workspace",
    context: "authenticated",
    module: API_HANDLERS_MODULE,
  },
  createSafeRootHandler: {
    kind: "root",
    context: "authenticated",
    module: API_HANDLERS_MODULE,
  },
  createSafeSessionHandler: {
    kind: "session",
    context: "authenticated",
    module: API_HANDLERS_MODULE,
  },
  createSafeTokenHandler: {
    kind: "token",
    context: "self-authorized",
    module: API_HANDLERS_MODULE,
  },
  createSafePublicHandler: {
    kind: "public",
    context: "anonymous",
    module: API_HANDLERS_MODULE,
  },
  createSafeBoundedPublicHandler: {
    kind: "public",
    context: "anonymous",
    module: API_HANDLERS_MODULE,
  },
  createSafeUncheckedBoundedPublicHandler: {
    kind: "public",
    context: "anonymous",
    module: API_HANDLERS_MODULE,
  },
  createSafePublicSubjectHandler: {
    kind: "public",
    context: "anonymous",
    module: PUBLIC_SUBJECT_MODULE,
  },
  createSafePublicSubjectFollowUpHandler: {
    kind: "public",
    context: "anonymous",
    module: PUBLIC_SUBJECT_MODULE,
  },
} as const satisfies Record<`createSafe${string}Handler`, SafeHandlerScope>;

export type SafeHandlerFactory = keyof typeof SAFE_HANDLER_FACTORIES;

export const isSafeHandlerFactory = (
  name: string,
): name is SafeHandlerFactory => Object.hasOwn(SAFE_HANDLER_FACTORIES, name);

/** The factories whose scope matches, in map order. */
export const factoriesWhere = (
  predicate: (scope: SafeHandlerScope) => boolean,
): SafeHandlerFactory[] =>
  Object.entries(SAFE_HANDLER_FACTORIES)
    .filter(([, scope]) => predicate(scope))
    .map(([name]) => name)
    .filter(isSafeHandlerFactory);

export const SAFE_HANDLER_FACTORY_NAMES = factoriesWhere(() => true);
