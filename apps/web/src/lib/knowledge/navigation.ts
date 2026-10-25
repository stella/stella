import type { ComponentType, SVGProps } from "react";

import { linkOptions } from "@tanstack/react-router";

import {
  ClipboardCheckIcon,
  LayoutTemplateIcon,
  PackageIcon,
  PaletteIcon,
  TextQuoteIcon,
  WorkflowIcon,
} from "@stll/ui/icons";

import type { TranslationKey } from "@/i18n/types";

export type KnowledgeSection = {
  key: "templates" | "styles" | "clauses" | "playbooks" | "workflows" | "tools";
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  link: {
    to:
      | "/knowledge/templates"
      | "/knowledge/styles"
      | "/knowledge/clauses"
      | "/knowledge/playbooks"
      | "/knowledge/workflows"
      | "/knowledge/tools";
  };
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
    link: linkOptions({ to: "/knowledge/tools" }),
    titleKey: "knowledge.sections.tools.title",
  },
  {
    key: "templates",
    icon: LayoutTemplateIcon,
    link: linkOptions({ to: "/knowledge/templates" }),
    titleKey: "knowledge.sections.templates.title",
  },
  {
    key: "styles",
    icon: PaletteIcon,
    link: linkOptions({ to: "/knowledge/styles" }),
    titleKey: "styleSets.title",
  },
  {
    key: "clauses",
    icon: TextQuoteIcon,
    link: linkOptions({ to: "/knowledge/clauses" }),
    titleKey: "common.clauses",
  },
  {
    key: "playbooks",
    icon: ClipboardCheckIcon,
    link: linkOptions({ to: "/knowledge/playbooks" }),
    titleKey: "common.playbooks",
  },
  {
    key: "workflows",
    icon: WorkflowIcon,
    link: linkOptions({ to: "/knowledge/workflows" }),
    titleKey: "common.workflows",
  },
];
