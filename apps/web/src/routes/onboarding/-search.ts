import * as v from "valibot";

import { toAppRedirectTo } from "@/lib/redirect";
import { optionalFlagSearchSchema } from "@/lib/schema";
import { routeSearchSchema } from "@/route-search-params";

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
