import { expectTypeOf } from "bun:test";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { WebApiRoutes } from "@/lib/eden-client";

// JSON carries a timestamp column as its ISO string and the client never
// revives it, so a response type claiming `Date` would let `.getTime()`
// type-check and throw at runtime.

expectTypeOf<PublicCaseLawDecision["createdAt"]>().toEqualTypeOf<string>();
expectTypeOf<PublicCaseLawDecision["updatedAt"]>().toEqualTypeOf<string>();

expectTypeOf<
  WebApiRoutes["workspaces"][":workspaceId"]["get"]["response"][200]["createdAt"]
>().toEqualTypeOf<string>();
