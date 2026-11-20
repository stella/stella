import type { ComponentType, ReactNode, SVGProps } from "react";

import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import type { KnowledgeSection } from "@/lib/knowledge/navigation";

/*
 * The Knowledge landing's shape (./knowledge-landing-view.tsx): its column,
 * the grid of section cards and a card's body, with no behaviour, so the
 * landing's loading view draws the cards it stands in for before any
 * provider mounts.
 */

/** The landing's column: the grid, and a line under it. */
export const KnowledgeLandingFrame = ({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}) => (
  <div className="flex flex-1 flex-col p-6" data-slot="knowledge-landing">
    <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
    {footer}
  </div>
);

/** A section card's surface. */
export const KNOWLEDGE_CARD_CLASS = cn(
  "bg-card flex h-full flex-col rounded-xl border p-5",
  "hover:border-foreground/15 hover:shadow-sm",
);

/** What a section card shows: the section's tile, title and description,
 *  and an optional note under them. */
export const KnowledgeCardBody = ({
  description,
  icon: Icon,
  note,
  title,
}: {
  description: ReactNode;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  note?: ReactNode;
  title: ReactNode;
}) => (
  <>
    <div className="bg-muted flex size-10 items-center justify-center rounded-lg">
      <Icon className="size-5" />
    </div>
    <div className="mt-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      {note !== undefined && (
        <p className="text-muted-foreground mt-2 text-xs font-medium">{note}</p>
      )}
    </div>
  </>
);

// Each section's one-line description, as the landing words it.
const SECTION_DESCRIPTION_KEYS = {
  clauses: "knowledge.sections.clauses.description",
  playbooks: "knowledge.sections.playbooks.description",
  styles: "styleSets.description",
  templates: "knowledge.sections.templates.description",
  tools: "knowledge.sections.tools.description",
  workflows: "knowledge.sections.workflows.description",
} as const satisfies Record<KnowledgeSection["key"], PendingTextKey>;

/** The message that describes a section on its card. */
export const knowledgeSectionDescriptionKey = (
  key: KnowledgeSection["key"],
): (typeof SECTION_DESCRIPTION_KEYS)[KnowledgeSection["key"]] =>
  SECTION_DESCRIPTION_KEYS[key];

/**
 * The landing while it loads: the cards of the sections it will show, their
 * words as the app's messages give them, or the empty grid while which
 * sections those are is not known yet.
 */
export const KnowledgeLandingPendingView = ({
  sections,
}: {
  sections: readonly KnowledgeSection[] | null;
}) => (
  <KnowledgeLandingFrame>
    {sections?.map((section) => (
      <div
        aria-hidden="true"
        className={KNOWLEDGE_CARD_CLASS}
        data-section={section.key}
        data-slot="knowledge-section-card-pending"
        key={section.key}
      >
        <KnowledgeCardBody
          description={
            <PendingText
              barClassName="w-48"
              id={knowledgeSectionDescriptionKey(section.key)}
            />
          }
          icon={section.icon}
          title={<PendingText barClassName="w-20" id={section.titleKey} />}
        />
      </div>
    ))}
  </KnowledgeLandingFrame>
);
