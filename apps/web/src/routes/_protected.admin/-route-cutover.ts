import type * as v from "valibot";

import { optionalSearchStringSchema } from "@/lib/schema";
import { routeSearchSchema } from "@/route-search-params";

const ADMIN_PREFIX = "/admin";
const ORGANIZATION_SETTINGS_PREFIX = "/settings/organization";

export const organizationSettingsSearchSchema = routeSearchSchema({
  q: optionalSearchStringSchema(),
});

export type OrganizationSettingsSearch = v.InferOutput<
  typeof organizationSettingsSearchSchema
>;

/** Owns root and legacy routing so a destination cannot omit validated search. */
export const organizationSettingsDestination = (
  pathname: string,
  search: OrganizationSettingsSearch,
) => {
  const suffix = pathname.startsWith(ADMIN_PREFIX)
    ? pathname.slice(ADMIN_PREFIX.length)
    : "";
  return {
    to: `${ORGANIZATION_SETTINGS_PREFIX}${
      suffix === "" || suffix === "/" ? "/general" : suffix
    }`,
    search,
  };
};
