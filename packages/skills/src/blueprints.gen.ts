// eslint-disable-next-line typescript-eslint/triple-slash-reference
/// <reference path="./markdown.d.ts" />

import blueprint0 from "../blueprints/answer-from-sources/SKILL.md" with { type: "text" };
import blueprint0Resource0 from "../blueprints/answer-from-sources/prompts/research.prompt.md" with { type: "text" };
import blueprint0Resource1 from "../blueprints/answer-from-sources/references/sources/guide.md" with { type: "text" };
import blueprint1 from "../blueprints/blank/SKILL.md" with { type: "text" };
import blueprint2 from "../blueprints/check-against-rules/SKILL.md" with { type: "text" };
import blueprint2Resource0 from "../blueprints/check-against-rules/prompts/review.prompt.md" with { type: "text" };
import blueprint2Resource1 from "../blueprints/check-against-rules/references/case-law/guide.md" with { type: "text" };
import blueprint2Resource2 from "../blueprints/check-against-rules/references/checklist.md" with { type: "text" };
import blueprint2Resource3 from "../blueprints/check-against-rules/references/guidelines/guide.md" with { type: "text" };
import blueprint2Resource4 from "../blueprints/check-against-rules/references/jurisdiction/guide.md" with { type: "text" };
import blueprint3 from "../blueprints/intake-to-draft/SKILL.md" with { type: "text" };
import blueprint3Resource0 from "../blueprints/intake-to-draft/prompts/draft.prompt.md" with { type: "text" };
import blueprint3Resource1 from "../blueprints/intake-to-draft/references/muster/guide.md" with { type: "text" };
import blueprint3Resource2 from "../blueprints/intake-to-draft/references/style.md" with { type: "text" };

export const BLUEPRINTS = [
  {
    id: "answer-from-sources",
    source: blueprint0,
    resources: [
      { kind: "prompt", path: "prompts/research.prompt.md", source: blueprint0Resource0 },
      { kind: "reference", path: "references/sources/guide.md", source: blueprint0Resource1 }
    ],
  },
  {
    id: "blank",
    source: blueprint1,
    resources: [

    ],
  },
  {
    id: "check-against-rules",
    source: blueprint2,
    resources: [
      { kind: "prompt", path: "prompts/review.prompt.md", source: blueprint2Resource0 },
      { kind: "reference", path: "references/case-law/guide.md", source: blueprint2Resource1 },
      { kind: "reference", path: "references/checklist.md", source: blueprint2Resource2 },
      { kind: "reference", path: "references/guidelines/guide.md", source: blueprint2Resource3 },
      { kind: "reference", path: "references/jurisdiction/guide.md", source: blueprint2Resource4 }
    ],
  },
  {
    id: "intake-to-draft",
    source: blueprint3,
    resources: [
      { kind: "prompt", path: "prompts/draft.prompt.md", source: blueprint3Resource0 },
      { kind: "reference", path: "references/muster/guide.md", source: blueprint3Resource1 },
      { kind: "reference", path: "references/style.md", source: blueprint3Resource2 }
    ],
  }
] as const;
