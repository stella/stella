import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects dynamic replacement strings for both replacement methods", async () => {
  expect(
    await lintSingleRule(
      "require-function-replacer",
      `text.replace(pattern, dynamic);
text.replaceAll(pattern, \`prefix-\${dynamic}\`);
text["replace"](pattern, object.field);
text.replace(pattern, compute());
text.replace(pattern, condition ? a : b);`,
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("accepts function replacers and author-visible replacement syntax", async () => {
  expect(
    await lintSingleRule(
      "require-function-replacer",
      'text.replace(pattern, () => dynamic);\ntext.replaceAll(pattern, function(match) { return dynamic; });\ntext.replace(pattern, "$&");\ntext.replaceAll(pattern, `$$`);',
    ),
  ).toEqual([]);
});

test("resolves local and hoisted function bindings without accepting shadowed parameters", async () => {
  expect(
    await lintSingleRule(
      "require-function-replacer",
      "function replaceValue() { return dynamic; }\ntext.replace(pattern, replaceValue);\nconst arrow = () => dynamic;\nlet expression = function() { return dynamic; };\ntext.replaceAll(pattern, arrow);\ntext.replace(pattern, expression);\nfunction local(arrow) { text.replace(pattern, arrow); }",
    ),
  ).toEqual([7]);
});

test("requires a wrapper for imports and function aliases the syntax cannot prove", async () => {
  expect(
    await lintSingleRule(
      "require-function-replacer",
      'import { replacer } from "replacements";\nfunction original() { return dynamic; }\nconst alias = original;\ntext.replace(pattern, replacer);\ntext.replace(pattern, alias);',
    ),
  ).toEqual([4, 5]);
});

test("leaves spread calls and nonstring HTMLRewriter options alone", async () => {
  expect(
    await lintSingleRule(
      "require-function-replacer",
      "text.replace(...args);\ntext.replace(pattern);\nelement.replace(content, { html: true });",
    ),
  ).toEqual([]);
});
