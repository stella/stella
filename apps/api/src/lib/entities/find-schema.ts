import * as v from "valibot";

import { ENTITY_FIND_TERM_MIN_LENGTH } from "@stll/api-contract";

import { resourceIdSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

/**
 * Deliberately without a default: a scope that omitted `type` is rejected
 * rather than accepted as `all`. Accepting it would be the widening
 * direction; the find would silently reach the row name the caller never
 * asked for.
 *
 * Spelled as a tuple rather than read from `ENTITY_FIND_SCOPE_TYPES`.
 * `find-schema.test.ts` binds the tuple to the contract list in both
 * directions, at compile time and at runtime, so a new scope kind still
 * cannot drift out of the wire schema.
 */
const tFindScopeType = v.picklist(["all", "columns"]);

/**
 * The columns the find reaches, resolved by the client. `all` also matches the
 * displayed name; `columns` is the narrowed state. The list is explicit in both
 * because the group-counts endpoint takes no field selection and could not
 * recompute a default that agreed with the rows.
 */
export const tFindScope = v.object({
  propertyIds: v.pipe(
    v.array(resourceIdSchema("property")),
    v.maxLength(LIMITS.propertiesCount),
  ),
  type: tFindScopeType,
});

/**
 * The floor again, over the term with its padding removed.
 *
 * `minLength` counts the term as it arrives, while the SQL trims before
 * building the pattern, so `"  ab  "` would clear a floor of three and still
 * leave the trigram index a two-character term to look up. This says the same
 * thing about the trimmed term: the padding, then the floor between a first
 * and last non-space. `\S` after `\s*` pins the leading run to exactly the
 * padding without a lookahead, which the CLI's `--input` example builder
 * cannot walk past.
 *
 * `find-schema.test.ts` states the rule this stands for over
 * `ENTITY_FIND_TERM_MIN_LENGTH`, so a floor the shape cannot express fails
 * there rather than silently accepting the wrong terms.
 */
const TRIMMED_TERM_PATTERN = `^\\s*\\S[\\s\\S]{${
  ENTITY_FIND_TERM_MIN_LENGTH - 2
},}\\S\\s*$`;

/**
 * The find request field, shared by the three readers a table view issues: the
 * row window, each group's window, and the group counts. One schema because
 * their answers have to agree — group headers that count rows the grid does
 * not show is the bug this prevents.
 *
 * Term and scope are one object rather than two optional fields, so a term
 * cannot arrive without the columns it is meant to reach.
 */
export const tFind = v.pipe(
  v.object({
    scope: tFindScope,
    term: v.pipe(
      v.string(),
      v.minLength(ENTITY_FIND_TERM_MIN_LENGTH),
      v.maxLength(LIMITS.searchQueryMaxLength),
      v.regex(new RegExp(TRIMMED_TERM_PATTERN, "u")),
    ),
  }),
  v.description(
    "Filter rows to those whose displayed name or chosen columns contain " +
      "this literal substring. Not `search`: that ranks an asynchronous " +
      "index of document titles, this filters exactly what the grid renders " +
      "and adds no sort keys. `scope.type` `all` also matches the name, " +
      "`columns` matches only `scope.propertyIds`. `term` is at least " +
      `${ENTITY_FIND_TERM_MIN_LENGTH} characters once trimmed: the cells are ` +
      "read through a trigram index, which a shorter term cannot use.",
  ),
);
