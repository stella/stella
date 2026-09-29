import type { ComponentType, ReactNode, SVGProps } from "react";

import { Link } from "@tanstack/react-router";

import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

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
  ({ to: KnowledgeSection["to"] } | { onOpen: () => void });

type KnowledgeLandingViewProps = {
  cards: readonly KnowledgeLandingCard[];
  /** A line under the cards. */
  footer?: ReactNode;
};

const CARD_CLASS = cn(
  "bg-card flex h-full flex-col rounded-xl border p-5",
  "hover:border-foreground/15 hover:shadow-sm",
);

const CardBody = ({ card }: { card: LandingCardContent }) => {
  const Icon = card.icon;
  return (
    <>
      <div
        className={cn(
          "flex size-10 items-center justify-center",
          "bg-muted rounded-lg",
        )}
      >
        <Icon className="size-5" />
      </div>
      <div className="mt-3">
        <h2 className="text-sm font-semibold">{card.title}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{card.description}</p>
        {card.note !== undefined && (
          <p className="text-muted-foreground mt-2 text-xs font-medium">
            {card.note}
          </p>
        )}
      </div>
    </>
  );
};

/** The Knowledge landing: one card per section the visitor can reach. */
export const KnowledgeLandingView = ({
  cards,
  footer,
}: KnowledgeLandingViewProps) => (
  <div className="flex flex-1 flex-col p-6">
    <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) =>
        "to" in card ? (
          <Link className={CARD_CLASS} key={card.key} to={card.to}>
            <CardBody card={card} />
          </Link>
        ) : (
          <button
            className={cn(CARD_CLASS, "text-start")}
            key={card.key}
            onClick={card.onOpen}
            type="button"
          >
            <CardBody card={card} />
          </button>
        ),
      )}
    </div>
    {footer}
  </div>
);

const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f"];

/** The landing's shape while the visitor is not known yet. */
export const KnowledgeLandingSkeleton = () => (
  <div className="flex flex-1 flex-col p-6">
    <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {SKELETON_KEYS.map((key) => (
        <Skeleton className="h-36 rounded-xl" key={key} />
      ))}
    </div>
  </div>
);
