import type { ComponentType, ReactNode, SVGProps } from "react";

import { Link } from "@tanstack/react-router";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import {
  KNOWLEDGE_CARD_CLASS,
  KnowledgeCardBody,
  KnowledgeLandingFrame,
} from "@/features/knowledge/views/knowledge-landing.pending";
import type { KnowledgeCataloguePath } from "@/lib/knowledge/knowledge-catalogues";
import type { KnowledgeSection } from "@/lib/knowledge/navigation";

type LandingCardContent = {
  key: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  description: string;
  /** A short note under the description, e.g. what opening it needs. */
  note?: string | undefined;
};

/** A Knowledge section card: a link to the section, or a button when the
 *  section needs something first. */
export type KnowledgeLandingCard = LandingCardContent &
  (
    | { to: KnowledgeSection["to"] | KnowledgeCataloguePath }
    | { onOpen: () => void }
  );

type KnowledgeLandingViewProps = {
  cards: readonly KnowledgeLandingCard[];
  /** A line under the cards. */
  footer?: ReactNode;
};

const CardBody = ({ card }: { card: LandingCardContent }) => (
  <KnowledgeCardBody
    description={card.description}
    icon={card.icon}
    note={card.note}
    title={card.title}
  />
);

/** The Knowledge landing: one card per section the visitor can reach. */
export const KnowledgeLandingView = ({
  cards,
  footer,
}: KnowledgeLandingViewProps) => (
  <KnowledgeLandingFrame footer={footer}>
    {cards.map((card) =>
      "to" in card ? (
        <Link className={KNOWLEDGE_CARD_CLASS} key={card.key} to={card.to}>
          <CardBody card={card} />
        </Link>
      ) : (
        // A section that needs something first is a button; it draws the
        // same card as the linked sections beside it.
        <Button
          className="flex h-full"
          key={card.key}
          onClick={card.onOpen}
          variant="plain"
        >
          <div className={cn(KNOWLEDGE_CARD_CLASS, "w-full")}>
            <CardBody card={card} />
          </div>
        </Button>
      ),
    )}
  </KnowledgeLandingFrame>
);
