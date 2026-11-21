import * as v from "valibot";

import { routeSearchSchema } from "@/route-search-params";

import { isVisualName } from "./-visual-metadata";
import type { VisualName } from "./-visual-metadata";

export const visualSearchSchema = routeSearchSchema({
  visual: v.optional(v.custom<VisualName>(isVisualName)),
});
