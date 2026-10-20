import type Elysia from "elysia";

/** The route registry carried by Elysia's public application type. */
export type RoutesOf<TApp> =
  TApp extends Elysia<
    infer _BasePath,
    infer _Scope,
    infer _Singleton,
    infer _Definitions,
    infer _Metadata,
    infer Routes,
    infer _Ephemeral,
    infer _Volatile
  >
    ? Routes
    : never;
