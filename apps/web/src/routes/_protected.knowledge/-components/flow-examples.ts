import type { useTranslations } from "use-intl";

import type { FlowStep } from "@/routes/_protected.knowledge/-components/flow-types";

// Client-side starter presets shown as "start from an example" cards on the
// empty workflows list. Each preset is a function of the translator so the
// prefilled draft (name, description, step prompts) lands in the viewer's
// language instead of being hardcoded to English.

export const FLOW_EXAMPLE_KEYS = [
  "nda-intake",
  "due-diligence",
  "document-summary",
] as const;
export type FlowExampleKey = (typeof FLOW_EXAMPLE_KEYS)[number];

export type FlowExample = {
  name: string;
  description: string;
  steps: FlowStep[];
};

type Translate = ReturnType<typeof useTranslations<"flows.examples">>;

const ndaIntakeExample = (t: Translate): FlowExample => ({
  name: t("ndaIntake.name"),
  description: t("ndaIntake.description"),
  steps: [
    {
      kind: "ai",
      name: t("ndaIntake.reviewStepName"),
      prompt: t("ndaIntake.reviewStepPrompt"),
      includeDocuments: true,
    },
    {
      kind: "review-gate",
      name: t("ndaIntake.reviewGateStepName"),
      instructions: t("ndaIntake.reviewGateInstructions"),
    },
    {
      kind: "create-document",
      name: t("ndaIntake.createStepName"),
      documentTitle: t("ndaIntake.documentTitle"),
    },
  ],
});

const dueDiligenceExample = (t: Translate): FlowExample => ({
  name: t("dueDiligence.name"),
  description: t("dueDiligence.description"),
  steps: [
    {
      kind: "ai",
      name: t("dueDiligence.reviewStepName"),
      prompt: t("dueDiligence.reviewStepPrompt"),
      includeDocuments: true,
    },
    {
      kind: "review-gate",
      name: t("dueDiligence.reviewGateStepName"),
      instructions: t("dueDiligence.reviewGateInstructions"),
    },
    {
      kind: "create-document",
      name: t("dueDiligence.createStepName"),
      documentTitle: t("dueDiligence.documentTitle"),
    },
  ],
});

const documentSummaryExample = (t: Translate): FlowExample => ({
  name: t("documentSummary.name"),
  description: t("documentSummary.description"),
  steps: [
    {
      kind: "ai",
      name: t("documentSummary.summaryStepName"),
      prompt: t("documentSummary.summaryStepPrompt"),
      includeDocuments: true,
    },
    {
      kind: "create-document",
      name: t("documentSummary.createStepName"),
      documentTitle: t("documentSummary.documentTitle"),
    },
  ],
});

const FLOW_EXAMPLE_BUILDERS = {
  "nda-intake": ndaIntakeExample,
  "due-diligence": dueDiligenceExample,
  "document-summary": documentSummaryExample,
} as const satisfies Record<FlowExampleKey, (t: Translate) => FlowExample>;

export const buildFlowExample = (
  key: FlowExampleKey,
  t: Translate,
): FlowExample => FLOW_EXAMPLE_BUILDERS[key](t);
