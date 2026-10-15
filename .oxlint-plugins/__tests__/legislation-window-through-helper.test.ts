import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects direct raw and interpolated SQL comparisons", async () => {
  expect(
    await lintSingleRule(
      "legislation-window-through-helper",
      `sql\`WHERE newer.version_valid_from <= \${asOf}\`;\nsql\`\${versions.versionValidTo} > \${date}\`;\nsql.raw("version_valid_to IS NULL");`,
      { plugin: "legislation-window" },
    ),
  ).toEqual([1, 2, 3]);
});

test("rejects relational and Drizzle comparisons through stable and destructured aliases", async () => {
  expect(
    await lintSingleRule(
      "legislation-window-through-helper",
      "const from = row.versionValidFrom;\nfrom <= date;\nconst { versionValidTo: to } = row;\nto > date;\nlt(from, date);\nisNull(ref.validTo);",
      { plugin: "legislation-window" },
    ),
  ).toEqual([2, 4, 5, 6]);
});

test("accepts helper eligibility selecting ordering and display null checks", async () => {
  expect(
    await lintSingleRule(
      "legislation-window-through-helper",
      "inForceOn(ref, date);\nopenedBy(ref, date);\nselect({ versionValidFrom: row.versionValidFrom });\norderBy(row.versionValidTo);\nrow.versionValidFrom === null;\nsql`SELECT version_valid_from::text AS version_valid_from FROM versions`;",
      { plugin: "legislation-window" },
    ),
  ).toEqual([]);
});

test("ignores SQL comments and comparisons hidden behind documented opaque shapes", async () => {
  expect(
    await lintSingleRule(
      "legislation-window-through-helper",
      `sql\`SELECT x /* version_valid_from <= date */\`;\nsql\`coalesce(version_valid_from, epoch) > \${date}\`;\nrow[key] <= date;`,
      { plugin: "legislation-window" },
    ),
  ).toEqual([]);
});
