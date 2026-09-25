import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { WebApiRoutes } from "@/lib/eden-client";

// JSON carries a timestamp column as its ISO string and the client never
// revives it, so a response type claiming `Date` would let `.getTime()`
// type-check and throw at runtime.

type Expect<Condition extends true> = Condition;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type DecisionTimestampsAreWireStrings = Expect<
  Equal<
    Pick<PublicCaseLawDecision, "createdAt" | "updatedAt">,
    { createdAt: string; updatedAt: string }
  >
>;

export type WorkspaceTimestampIsWireString = Expect<
  Equal<
    WebApiRoutes["workspaces"][":workspaceId"]["get"]["response"][200]["createdAt"],
    string
  >
>;
