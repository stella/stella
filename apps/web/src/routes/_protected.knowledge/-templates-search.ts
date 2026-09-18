import * as v from "valibot";

/**
 * `template` is the template open in the Studio: selecting one writes it,
 * leaving the Studio clears it, and a reload of /knowledge/templates reopens
 * it. A value that is not a string (`?template=1` parses as a number) degrades
 * to "no open template" instead of throwing into the router's error boundary.
 */
export const templatesSearchSchema = v.object({
  template: v.fallback(v.optional(v.string()), undefined),
});
