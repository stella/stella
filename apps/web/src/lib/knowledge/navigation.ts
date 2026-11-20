import type { ComponentType, SVGProps } from "react";

import {
  ClipboardCheckIcon,
  LayoutTemplateIcon,
  PackageIcon,
  PaletteIcon,
  TextQuoteIcon,
  WorkflowIcon,
} from "@stll/ui/icons";

import type { TranslationKey } from "@/i18n/types";
import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
import type { KnowledgeCataloguePath } from "@/lib/knowledge/knowledge-catalogues";

type KnowledgeSectionAccess =
  | {
      /** A visitor without an account reads the section's catalogue. */
      publicAccess: "catalogue";
      /** The catalogue's own address: `to` is the organization's page. */
      catalogueTo: KnowledgeCataloguePath;
    }
  | {
      /** A card that asks for an account, or no card at all. */
      publicAccess: "account" | "unavailable";
    };

export type KnowledgeSection = KnowledgeSectionAccess & {
  key: "templates" | "styles" | "clauses" | "playbooks" | "workflows" | "tools";
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** The organization's own page. */
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
    publicAccess: "catalogue",
    catalogueTo: KNOWLEDGE_CATALOGUE_PATHS.tools,
    icon: PackageIcon,
    to: "/knowledge/tools",
    titleKey: "knowledge.sections.tools.title",
  },
  {
    key: "templates",
    publicAccess: "catalogue",
    catalogueTo: KNOWLEDGE_CATALOGUE_PATHS.templates,
    icon: LayoutTemplateIcon,
    to: "/knowledge/templates",
    titleKey: "knowledge.sections.templates.title",
  },
  {
    key: "styles",
    publicAccess: "account",
    icon: PaletteIcon,
    to: "/knowledge/styles",
    titleKey: "styleSets.title",
  },
  {
    key: "clauses",
    publicAccess: "account",
    icon: TextQuoteIcon,
    to: "/knowledge/clauses",
    titleKey: "common.clauses",
  },
  {
    key: "playbooks",
    publicAccess: "catalogue",
    catalogueTo: KNOWLEDGE_CATALOGUE_PATHS.playbooks,
    icon: ClipboardCheckIcon,
    to: "/knowledge/playbooks",
    titleKey: "common.playbooks",
  },
  {
    key: "workflows",
    publicAccess: "unavailable",
    icon: WorkflowIcon,
    to: "/knowledge/workflows",
    titleKey: "common.workflows",
  },
];

/** Where a visitor without an account opens the section: its catalogue, or
 *  the organization's page that asks for an account. */
export const publicSectionPath = (section: KnowledgeSection) =>
  section.publicAccess === "catalogue" ? section.catalogueTo : section.to;
