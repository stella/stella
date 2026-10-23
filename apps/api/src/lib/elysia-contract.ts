/** The route registry carried by Elysia's public application type. */
export type RoutesOf<TApp> = TApp extends { readonly "~Routes": infer Routes }
  ? Routes
  : never;
