import { t } from "elysia";

import { ENTITY_FIND_SCOPE_TYPES } from "@stll/api-contract";

import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

/**
 * The find-in-table request fields, shared by the three readers a table view
 * issues: the row window, each group's window, and the group counts. One
 * schema because their answers have to agree — group headers that count rows
 * the grid does not show is the bug this prevents.
 */
export const tFind = t.String({ maxLength: LIMITS.searchQueryMaxLength });

/**
 * The columns the find reaches, resolved by the client. `all` also matches the
 * displayed name; `columns` is the narrowed state. The list is explicit in both
 * because the group-counts endpoint takes no field selection and could not
 * recompute a default that agreed with the rows.
 */
export const tFindScope = t.Object({
  propertyIds: t.Array(tSafeId("property"), {
    maxItems: LIMITS.propertiesCount,
  }),
  type: t.UnionEnum([...ENTITY_FIND_SCOPE_TYPES]),
});
