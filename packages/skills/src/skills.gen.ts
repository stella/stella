// eslint-disable-next-line typescript-eslint/triple-slash-reference
/// <reference path="./markdown.d.ts" />

import skill0 from "../skills/case-briefing/SKILL.md" with { type: "text" };
import skill0Resource0 from "../skills/case-briefing/knowledge/01-structural-elements.md" with { type: "text" };
import skill0Resource1 from "../skills/case-briefing/prompts/brief-case.prompt.md" with { type: "text" };
import skill0Resource2 from "../skills/case-briefing/prompts/extract-ratio.prompt.md" with { type: "text" };
import skill1 from "../skills/contract-analysis/SKILL.md" with { type: "text" };
import skill1Resource0 from "../skills/contract-analysis/knowledge/01-structural-components.md" with { type: "text" };
import skill1Resource1 from "../skills/contract-analysis/knowledge/02-analysis-patterns.md" with { type: "text" };
import skill1Resource2 from "../skills/contract-analysis/prompts/decompose-contract.prompt.md" with { type: "text" };
import skill1Resource3 from "../skills/contract-analysis/prompts/extract-contract-type.prompt.md" with { type: "text" };
import skill1Resource4 from "../skills/contract-analysis/prompts/extract-risk-allocation.prompt.md" with { type: "text" };
import skill2 from "../skills/data-protection/SKILL.md" with { type: "text" };
import skill2Resource0 from "../skills/data-protection/knowledge/01-data-protection-framework.md" with { type: "text" };
import skill2Resource1 from "../skills/data-protection/knowledge/02-lawful-basis-analysis.md" with { type: "text" };
import skill2Resource2 from "../skills/data-protection/knowledge/03-transparency-and-notices.md" with { type: "text" };
import skill2Resource3 from "../skills/data-protection/knowledge/04-processor-agreements.md" with { type: "text" };
import skill2Resource4 from "../skills/data-protection/knowledge/05-breach-assessment.md" with { type: "text" };
import skill2Resource5 from "../skills/data-protection/knowledge/06-cross-cutting-considerations.md" with { type: "text" };
import skill2Resource6 from "../skills/data-protection/prompts/assess-breach.prompt.md" with { type: "text" };
import skill2Resource7 from "../skills/data-protection/prompts/assess-processing.prompt.md" with { type: "text" };
import skill2Resource8 from "../skills/data-protection/prompts/review-dpa.prompt.md" with { type: "text" };
import skill2Resource9 from "../skills/data-protection/prompts/review-privacy-notice.prompt.md" with { type: "text" };
import skill3 from "../skills/legal-interpretation/SKILL.md" with { type: "text" };
import skill3Resource0 from "../skills/legal-interpretation/knowledge/01-interpretation-methods.md" with { type: "text" };
import skill3Resource1 from "../skills/legal-interpretation/knowledge/02-reasoning-structure.md" with { type: "text" };
import skill3Resource2 from "../skills/legal-interpretation/knowledge/03-examples.md" with { type: "text" };
import skill3Resource3 from "../skills/legal-interpretation/knowledge/04-domain-rules.md" with { type: "text" };
import skill3Resource4 from "../skills/legal-interpretation/prompts/analyze-statute.prompt.md" with { type: "text" };

export const GENERATED_SKILLS = [
  {
    id: "case-briefing",
    source: skill0,
    resources: [
      { kind: "knowledge", path: "knowledge/01-structural-elements.md", source: skill0Resource0 },
      { kind: "prompt", path: "prompts/brief-case.prompt.md", source: skill0Resource1 },
      { kind: "prompt", path: "prompts/extract-ratio.prompt.md", source: skill0Resource2 }
    ],
  },
  {
    id: "contract-analysis",
    source: skill1,
    resources: [
      { kind: "knowledge", path: "knowledge/01-structural-components.md", source: skill1Resource0 },
      { kind: "knowledge", path: "knowledge/02-analysis-patterns.md", source: skill1Resource1 },
      { kind: "prompt", path: "prompts/decompose-contract.prompt.md", source: skill1Resource2 },
      { kind: "prompt", path: "prompts/extract-contract-type.prompt.md", source: skill1Resource3 },
      { kind: "prompt", path: "prompts/extract-risk-allocation.prompt.md", source: skill1Resource4 }
    ],
  },
  {
    id: "data-protection",
    source: skill2,
    resources: [
      { kind: "knowledge", path: "knowledge/01-data-protection-framework.md", source: skill2Resource0 },
      { kind: "knowledge", path: "knowledge/02-lawful-basis-analysis.md", source: skill2Resource1 },
      { kind: "knowledge", path: "knowledge/03-transparency-and-notices.md", source: skill2Resource2 },
      { kind: "knowledge", path: "knowledge/04-processor-agreements.md", source: skill2Resource3 },
      { kind: "knowledge", path: "knowledge/05-breach-assessment.md", source: skill2Resource4 },
      { kind: "knowledge", path: "knowledge/06-cross-cutting-considerations.md", source: skill2Resource5 },
      { kind: "prompt", path: "prompts/assess-breach.prompt.md", source: skill2Resource6 },
      { kind: "prompt", path: "prompts/assess-processing.prompt.md", source: skill2Resource7 },
      { kind: "prompt", path: "prompts/review-dpa.prompt.md", source: skill2Resource8 },
      { kind: "prompt", path: "prompts/review-privacy-notice.prompt.md", source: skill2Resource9 }
    ],
  },
  {
    id: "legal-interpretation",
    source: skill3,
    resources: [
      { kind: "knowledge", path: "knowledge/01-interpretation-methods.md", source: skill3Resource0 },
      { kind: "knowledge", path: "knowledge/02-reasoning-structure.md", source: skill3Resource1 },
      { kind: "knowledge", path: "knowledge/03-examples.md", source: skill3Resource2 },
      { kind: "knowledge", path: "knowledge/04-domain-rules.md", source: skill3Resource3 },
      { kind: "prompt", path: "prompts/analyze-statute.prompt.md", source: skill3Resource4 }
    ],
  }
] as const;
