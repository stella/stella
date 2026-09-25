import { describe, expect, test } from "bun:test";

import { findUnusedKeys, unusedKeysBaselineAfter } from "./i18n-usage";

const KEYS = [
  "chat.newChat",
  "chat.skills.scope.private",
  "chat.skills.scope.team",
  "common.cancel",
  "knowledge.agentSkills.importTitle",
  "knowledge.agentSkills.orphan",
  "orphan.entirely",
];

describe("findUnusedKeys", () => {
  test("a full key literal, a namespaced call, or a dynamic prefix counts as a use", () => {
    const sources = [
      'const label = t("common.cancel");',
      [
        'const tSkills = useTranslations("knowledge.agentSkills");',
        'tSkills("importTitle");',
      ].join("\n"),
      `const heading = t(\`chat.skills.scope.\${scope}\`);`,
      'export const KEYS = { new: "chat.newChat" } as const;',
    ];

    expect(findUnusedKeys(KEYS, sources)).toEqual([
      "knowledge.agentSkills.orphan",
      "orphan.entirely",
    ]);
  });

  test("a leaf literal counts only beside its namespace", () => {
    const sources = ['useTranslations("chat");', 'call("importTitle");'];

    expect(
      findUnusedKeys(["knowledge.agentSkills.importTitle"], sources),
    ).toEqual(["knowledge.agentSkills.importTitle"]);
  });

  test("a namespace-relative dynamic prefix covers the keys under it", () => {
    const sources = [
      [
        'const tScope = useTranslations("chat.skills");',
        `tScope(\`scope.\${value}\`);`,
      ].join("\n"),
    ];

    expect(
      findUnusedKeys(
        ["chat.skills.scope.private", "chat.skills.title"],
        sources,
      ),
    ).toEqual(["chat.skills.title"]);
  });
});

describe("unusedKeysBaselineAfter", () => {
  test("the baseline keeps only keys still unused and never adds one", () => {
    expect(
      unusedKeysBaselineAfter({
        baseline: ["a.used-now", "b.still-unused"],
        unused: ["b.still-unused", "c.newly-unused"],
      }),
    ).toEqual(["b.still-unused"]);
  });
});
