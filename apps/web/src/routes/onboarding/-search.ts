import * as v from "valibot";

import { toAppRedirectTo } from "@/lib/redirect";
import { routeSearchSchema } from "@/lib/route-search-params";
import { optionalFlagSearchSchema } from "@/lib/schema";

export const onboardingSearchSchema = routeSearchSchema({
  preview: optionalFlagSearchSchema,
  // Where the visitor was headed before signing up; the wizard ends there.
  redirectTo: v.optional(
    v.pipe(
      v.string(),
      v.transform((value: string) => toAppRedirectTo(value)),
    ),
  ),
});
