// oxlint-disable-next-line typescript-eslint/triple-slash-reference -- loads the ambient "*.md" module declaration; no ES import equivalent
/// <reference path="./markdown.d.ts" />

import skill0 from "../skills/playbook-builder/SKILL.md" with { type: "text" };

type GeneratedSkillEntry = {
  id: string;
  source: string;
  resources: readonly {
    kind: "knowledge" | "prompt";
    path: string;
    source: string;
  }[];
};

export const GENERATED_SKILLS: readonly GeneratedSkillEntry[] = [
  {
    id: "playbook-builder",
    source: skill0,
    resources: [],
  }
];
