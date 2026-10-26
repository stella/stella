import { expect, test } from "bun:test";

import oxlintConfig from "../../oxlint.config.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-case-folded-search-match";
const RULE_ID = `${RULE}/${RULE}`;

test("rejects substring compares on a case-folded string", async () => {
  const source = [
    "label.toLowerCase().includes(query);",
    "label.toLowerCase().includes(query.trim().toLowerCase());",
    "label.toLocaleLowerCase(locale).startsWith(query);",
    "label.trim().toLowerCase().indexOf(needle);",
    "label.toLowerCase().trim().includes(needle);",
    "label.toLowerCase().normalize('NFC').toWellFormed().includes(needle);",
    "(label as string).toLowerCase().includes(needle);",
    'label["toLowerCase"]().includes(needle);',
    `\`\${a} \${b}\`.toLowerCase().includes(needle);`,
    `label.toLowerCase().includes(\`\${query};\`);`,
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);
});

test("follows a never-reassigned binding to its case fold", async () => {
  const source = [
    "const haystack = label.toLowerCase();",
    "const trimmed = haystack.trim();",
    "haystack.includes(query);",
    "trimmed.startsWith(query);",
    "let reassigned = label.toLowerCase();",
    "reassigned = label;",
    "reassigned.includes(query);",
    "const plain = label.trim();",
    "plain.includes(query);",
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([3, 4]);
});

test("rejects case-folded keys handed to the literal key helpers", async () => {
  const source = [
    "containsSearchMatchKey(name.toLowerCase(), query);",
    "const needle = query.trim().toLowerCase();",
    "containsSearchMatchKey(name, needle);",
    "findSearchMatchKeyRanges(text.toLocaleLowerCase(), term);",
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([1, 3, 4]);
});

test("accepts constant tokens, the owner, and compares without a case fold", async () => {
  const source = [
    'fileName.toLowerCase().endsWith(".pdf");',
    'contentType.toLowerCase().startsWith("application/json");',
    "href.toLowerCase().startsWith(CHAT_DECISION_PASSAGE_HREF_PREFIX);",
    "href.toLowerCase().startsWith(PREFIXES.DECISION);",
    "message.toLowerCase().includes(`quota`);",
    "createSearchQueryMatcher(query)(label);",
    "filterBySearchQuery({ items, query, fields: (item) => [item.name] });",
    "label.includes(query);",
    "terms.indexOf(term);",
    'containsSearchMatchKey(message, "MIME type");',
    "containsSearchMatchKey(foldSearchMatchText(name), folded);",
    "fileName.toLowerCase() === extension;",
    `mime.toLowerCase().startsWith(\`\${MARKDOWN_MIME};\`);`,
  ].join("\n");
  expect(await lintSingleRule(RULE, source)).toEqual([]);
});

test("rejects a self-filtering combobox or command left on the collator filter", async () => {
  const source = [
    "<Combobox items={items} />;",
    "<Combobox<Option> items={items} value={value} />;",
    '<Command items={hits} mode="list" />;',
    "<Command items={hits} />;",
    "<Combobox filter={matchesComboboxItem} items={items} />;",
    "<Combobox filter={null} items={items} />;",
    '<Command items={hits} mode="none" />;',
    "<Combobox {...props} items={items} />;",
    "<Combobox value={value} />;",
    "<ComboboxPrimitive.Root items={items} />;",
  ].join("\n");
  expect(
    await lintSingleRule(RULE, source, { sourcePath: "picker.tsx" }),
  ).toEqual([1, 2, 3, 4]);
});

test("covers the web app and the design system outside tests, with one named exception", () => {
  const matching = oxlintConfig.overrides.filter(
    (override) => override.rules?.[RULE_ID] !== undefined,
  );
  expect(matching).toHaveLength(1);
  const [override] = matching;
  expect(override?.rules?.[RULE_ID]).toBe("error");
  expect(override?.files).toEqual(
    expect.arrayContaining([
      "apps/web/src/**/*.{ts,tsx}",
      "packages/ui/src/**/*.{ts,tsx}",
      "packages/workspace-ui/src/**/*.{ts,tsx}",
    ]),
  );
  expect(
    override !== undefined && "excludeFiles" in override
      ? override.excludeFiles
      : undefined,
  ).toEqual([
    "**/*.test.{ts,tsx}",
    "apps/web/src/components/workspaces/table/find-highlight.logic.ts",
    "packages/ui/src/components/fixtures/**",
  ]);
});
