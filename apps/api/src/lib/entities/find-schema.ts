import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

/**
 * Deliberately a union of literals, not `t.UnionEnum`: Elysia gives a
 * UnionEnum a default of its first member, so a scope that omitted `type`
 * would be accepted as `all` rather than rejected. That is the widening
 * direction; the find would silently reach the row name the caller never
 * asked for.
 *
 * Spelled as a tuple rather than mapped over `ENTITY_FIND_SCOPE_TYPES`:
 * `.map` returns an array, and Eden infers a union built from one as `never`
 * at this nesting depth, leaving the web client unable to send any scope at
 * all. `find-schema.test.ts` binds the tuple to the contract list in both
 * directions, at compile time and at runtime, so a new scope kind still
 * cannot drift out of the wire schema.
 */
const tFindScopeType = t.Union([t.Literal("all"), t.Literal("columns")]);

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
  type: tFindScopeType,
});

/**
 * The find request field, shared by the three readers a table view issues: the
 * row window, each group's window, and the group counts. One schema because
 * their answers have to agree — group headers that count rows the grid does
 * not show is the bug this prevents.
 *
 * Term and scope are one object rather than two optional fields, so a term
 * cannot arrive without the columns it is meant to reach.
 */
export const tFind = t.Object(
  {
    scope: tFindScope,
    term: t.String({ maxLength: LIMITS.searchQueryMaxLength }),
  },
  {
    description:
      "Filter rows to those whose displayed name or chosen columns contain " +
      "this literal substring. Not `search`: that ranks an asynchronous " +
      "index of document titles, this filters exactly what the grid renders " +
      "and adds no sort keys. `scope.type` `all` also matches the name, " +
      "`columns` matches only `scope.propertyIds`.",
  },
);
