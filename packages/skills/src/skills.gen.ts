// oxlint-disable-next-line typescript/triple-slash-reference -- loads the ambient "*.md" module declaration; no ES import equivalent
/// <reference path="./markdown.d.ts" />

import skill0 from "../skills/legal-interpretation/SKILL.md" with { type: "text" };
import skill0Resource0 from "../skills/legal-interpretation/references/domain-rules.md" with { type: "text" };
import skill0Resource1 from "../skills/legal-interpretation/references/examples.md" with { type: "text" };
import skill0Resource2 from "../skills/legal-interpretation/references/families/common-law.md" with { type: "text" };
import skill0Resource3 from "../skills/legal-interpretation/references/families/continental.md" with { type: "text" };
import skill0Resource4 from "../skills/legal-interpretation/references/families/international.md" with { type: "text" };
import skill0Resource5 from "../skills/legal-interpretation/references/methods.md" with { type: "text" };
import skill0Resource6 from "../skills/legal-interpretation/references/priority-and-limits.md" with { type: "text" };
import skill0Resource7 from "../skills/legal-interpretation/references/reasoning.md" with { type: "text" };
import skill1 from "../skills/playbook-builder/SKILL.md" with { type: "text" };

type GeneratedSkillEntry = {
  id: string;
  source: string;
  resources: readonly {
    path: string;
    source: string;
  }[];
};

export const GENERATED_SKILLS: readonly GeneratedSkillEntry[] = [
  {
    id: "legal-interpretation",
    source: skill0,
    resources: [
      { path: "references/domain-rules.md", source: skill0Resource0 },
      { path: "references/examples.md", source: skill0Resource1 },
      { path: "references/families/common-law.md", source: skill0Resource2 },
      { path: "references/families/continental.md", source: skill0Resource3 },
      { path: "references/families/international.md", source: skill0Resource4 },
      { path: "references/methods.md", source: skill0Resource5 },
      { path: "references/priority-and-limits.md", source: skill0Resource6 },
      { path: "references/reasoning.md", source: skill0Resource7 }
    ],
  },
  {
    id: "playbook-builder",
    source: skill1,
    resources: [],
  }
];
