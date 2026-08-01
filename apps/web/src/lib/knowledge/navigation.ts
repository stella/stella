import type { ComponentType, SVGProps } from "react";

import {
  ClipboardCheckIcon,
  LayoutTemplateIcon,
  PackageIcon,
  PaletteIcon,
  TextQuoteIcon,
  WorkflowIcon,
} from "lucide-react";

import type { TranslationKey } from "@/i18n/types";

// "prompts" used to be its own surface; after the prompts→skills
// consolidation, slash-command prompts live alongside richer skills
// on the Tools page. The sidebar entry was removed so the landing
// doesn't advertise a deleted destination.
export type KnowledgeSection = {
  key: "templates" | "styles" | "clauses" | "playbooks" | "workflows" | "tools";
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  to:
    | "/knowledge/templates"
    | "/knowledge/styles"
    | "/knowledge/clauses"
    | "/knowledge/playbooks"
    | "/knowledge/workflows"
    | "/knowledge/tools";
  // "clauses", "playbooks", and "workflows" reuse the shared common.* labels
  // instead of feature-scoped duplicates; other sections use their own title.
  titleKey: Extract<
    TranslationKey,
    | "knowledge.sections.templates.title"
    | "styleSets.title"
    | "knowledge.sections.tools.title"
    | "common.clauses"
    | "common.playbooks"
    | "common.workflows"
  >;
};

export const knowledgeSections: readonly KnowledgeSection[] = [
  {
    key: "tools",
    icon: PackageIcon,
    to: "/knowledge/tools",
    titleKey: "knowledge.sections.tools.title",
  },
  {
    key: "templates",
    icon: LayoutTemplateIcon,
    to: "/knowledge/templates",
    titleKey: "knowledge.sections.templates.title",
  },
  {
    key: "styles",
    icon: PaletteIcon,
    to: "/knowledge/styles",
    titleKey: "styleSets.title",
  },
  {
    key: "clauses",
    icon: TextQuoteIcon,
    to: "/knowledge/clauses",
    titleKey: "common.clauses",
  },
  {
    key: "playbooks",
    icon: ClipboardCheckIcon,
    to: "/knowledge/playbooks",
    titleKey: "common.playbooks",
  },
  {
    key: "workflows",
    icon: WorkflowIcon,
    to: "/knowledge/workflows",
    titleKey: "common.workflows",
  },
];
