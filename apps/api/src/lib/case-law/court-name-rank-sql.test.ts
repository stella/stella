import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  courtNameWeightSql,
  courtWeightSql,
} from "@/api/handlers/case-law/citation-score";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  courtNameTierSql,
  courtTierSqlFromMap,
  flattenCourtWeightEntries,
} from "@/api/lib/case-law/court-weights";

// Every jurisdiction ranked by name (AUT, CZE, EU, HUN, POL, SVK) evaluates
// exactly the SQL it did before directory courts were ranked by id: the
// snapshots were taken from the name renderers' output before that change,
// and the full renderers hand every non-directory row to that text unchanged.
test("the name rank SQL renders byte for byte as before", () => {
  const map = courtWeightMapFromSeed();
  const nameTier = courtNameTierSql({
    countryColumn: "d.country",
    courtColumn: "d.court",
    map,
  });
  const nameWeight = courtNameWeightSql(
    "citing_d.court",
    flattenCourtWeightEntries(map),
  );
  expect(nameTier).toMatchSnapshot("tier");
  expect(nameWeight).toMatchSnapshot("weight");

  const text = (fragment: SQL): string =>
    new PgDialect().sqlToQuery(fragment).sql;
  expect(
    text(
      courtTierSqlFromMap({
        countryColumn: "d.country",
        courtColumn: "d.court",
        courtIdColumn: "d.court_id",
        map,
      }),
    ),
  ).toEndWith(`ELSE ${nameTier} END`);
  expect(
    text(
      courtWeightSql({
        countryColumn: "citing_d.country",
        courtColumn: "citing_d.court",
        courtIdColumn: "citing_d.court_id",
        entries: flattenCourtWeightEntries(map),
      }),
    ),
  ).toEndWith(`ELSE ${nameWeight} END`);
});
