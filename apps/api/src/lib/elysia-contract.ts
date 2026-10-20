import type Elysia from "elysia";
import type { status } from "elysia";

/** The route registry carried by Elysia's public application type. */
export type RoutesOf<TApp> =
  TApp extends Elysia<
    infer _BasePath,
    infer _Singleton,
    infer _Definitions,
    infer _Metadata,
    infer Routes
  >
    ? Routes
    : never;

/** A status response, expressed through the public `status` factory. */
export type StatusResponse<
  Code extends Parameters<typeof status>[0],
  Body,
> = ReturnType<typeof status<Code, Body>>;
