import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-literal-decision-court";

setDefaultTimeout(20_000);

const lint = async (source: string) =>
  await lintSingleRule(RULE_NAME, source, { sourcePath: "adapter.ts" });

describe.serial("no-literal-decision-court", () => {
  test("reports every court an adapter states for itself", async () => {
    const source = [
      `const row = { court: "Nejvyšší soud" };`,
      `const asserted = { court: "Ústavní soud" as const };`,
      `const metadata = { metadata: { court: \`RIS \${application}\` } };`,
      `parseDecisionHtml({ caseNumber, court: "Nejvyšší správní soud" });`,
      "",
    ].join("\n");

    // One report per stated court: the row, the asserted literal, the
    // metadata mirror, and the parser argument that carries the same
    // attribution into the stored document.
    expect(await lint(source)).toEqual([1, 2, 3, 4]);
  });

  test("accepts a court resolved from the decision's own record", async () => {
    const source = [
      "const court = czDecisionCourt({ adapterKey, ecli, publisherCourt, sourceDocumentId });",
      "const row = { court, metadata: { court } };",
      "const stated = { court: item.sud?.nazov };",
      "const reparsed = { court: stored.court };",
      "const listed = { court: statedCourt ?? publisherCourt };",
      // A court-valued query parameter filters a listing; it attributes
      // nothing, and is named for what it filters.
      `fetchListing({ courtFilter: "AUSL" });`,
      "type Detail = { court: string };",
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });

  test("an absent court requires an explicit quarantined listing identity", async () => {
    const source = [
      'const quarantine = { court: "", isListingOnly: true, caseNumberIsPlaceholder: true };',
      'const full = { court: "" };',
      'const listing = { court: "", isListingOnly: true };',
      'const placeholder = { court: "", caseNumberIsPlaceholder: true };',
      'const published = { court: "", isListingOnly: false, caseNumberIsPlaceholder: true };',
      'const named = { court: "Nejvyšší soud", isListingOnly: true, caseNumberIsPlaceholder: true };',
      'const overwritten = { court: "", isListingOnly: true, caseNumberIsPlaceholder: true, ...unknown };',
      'const duplicate = { court: "", isListingOnly: true, caseNumberIsPlaceholder: true, isListingOnly: false };',
      'const computed = { court: "", [isListingOnly]: true, caseNumberIsPlaceholder: true };',
    ].join("\n");
    expect(await lint(source)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
