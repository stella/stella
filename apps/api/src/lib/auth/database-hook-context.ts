import type { GenericEndpointContext } from "@better-auth/core";
import type { BetterAuthOptions } from "better-auth";

/**
 * The context a Better Auth database hook receives: the endpoint the write
 * runs in, or nothing when the write runs outside one, as a server call such
 * as `internalAdapter.createSession` from a worker does. Better Auth declares
 * the absent case as `null` but passes `undefined` (it reads the context with
 * `tryGetCurrentAuthEndpointContext`), so a hook and every helper it hands the
 * context to accept both and decide the absent case explicitly.
 */
export type DatabaseHookContext = GenericEndpointContext | null | undefined;

type CoreDatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;

/** Better Auth's hook shapes, each hook taking the context it really gets. */
type WithHookContext<T> = T extends (
  row: infer Row,
  context: GenericEndpointContext | null,
) => infer Output
  ? (row: Row, context: DatabaseHookContext) => Output
  : T extends object
    ? { [Key in keyof T]: WithHookContext<T[Key]> }
    : T;

/** Hooks on a plugin model, which Better Auth runs like its own models'. */
type PluginModelHooks<Row> = {
  create?: {
    before?: (row: Row, context: DatabaseHookContext) => Promise<unknown>;
    after?: (row: Row, context: DatabaseHookContext) => Promise<unknown>;
  };
};

/**
 * The database hooks, typed with the context Better Auth passes at runtime:
 * `databaseHooks: { ... } satisfies StellaDatabaseHooks` types every hook's
 * context, so a helper narrowed to the declared `| null` cannot be handed it.
 * Each hook still fits the shape Better Auth declares.
 */
export type StellaDatabaseHooks = WithHookContext<CoreDatabaseHooks> & {
  member?: PluginModelHooks<{ organizationId: string; userId: string }>;
  invitation?: PluginModelHooks<{ organizationId: string }>;
};
