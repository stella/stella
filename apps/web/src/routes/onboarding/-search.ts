import * as v from "valibot";

import { toAppRedirectTo } from "@/lib/redirect";

export const onboardingSearchSchema = v.strictObject({
  preview: v.optional(v.boolean()),
  // Where the visitor was headed before signing up; the wizard ends there.
  redirectTo: v.optional(
    v.pipe(
      v.string(),
      v.transform((value: string) => toAppRedirectTo(value)),
    ),
  ),
});
