import { describe, expect, test } from "bun:test";

import {
  findKeyUsages,
  findUnusedKeys,
  unusedKeysBaselineAfter,
} from "./i18n-usage";

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

describe("findKeyUsages", () => {
  test("points at the lines that name a key, directly, by namespace or by a segment prefix", () => {
    const files = [
      {
        path: "cancel.tsx",
        text: 'const x = 1;\nconst label = t("common.cancel");',
      },
      {
        path: "skills.tsx",
        text: [
          'const tSkills = useTranslations("knowledge.agentSkills");',
          "const y = 2;",
          'tSkills("importTitle");',
        ].join("\n"),
      },
      {
        path: "scope.tsx",
        text: `const heading = t(\`chat.skills.scope.\${scope}\`);`,
      },
    ];

    const usages = findKeyUsages({
      keys: [
        "common.cancel",
        "knowledge.agentSkills.importTitle",
        "chat.skills.scope.team",
      ],
      files,
    });

    expect(usages.get("common.cancel")).toEqual([
      {
        path: "cancel.tsx",
        line: 2,
        code: 'const label = t("common.cancel");',
      },
    ]);
    expect(usages.get("knowledge.agentSkills.importTitle")).toEqual([
      { path: "skills.tsx", line: 3, code: 'tSkills("importTitle");' },
    ]);
    expect(usages.get("chat.skills.scope.team")).toEqual([
      {
        path: "scope.tsx",
        line: 1,
        code: `const heading = t(\`chat.skills.scope.\${scope}\`);`,
      },
    ]);
  });

  test("a template prefix inside a key segment keeps the key used but shows no line", () => {
    const text = `const id = \`c\${index}\`;`;
    expect(findUnusedKeys(["chat.newChat"], [text])).toEqual([]);
    expect(
      findKeyUsages({
        keys: ["chat.newChat"],
        files: [{ path: "ids.ts", text }],
      }).get("chat.newChat"),
    ).toEqual([]);
  });
});
