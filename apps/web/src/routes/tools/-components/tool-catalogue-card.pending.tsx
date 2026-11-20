import type { ReactElement, ReactNode } from "react";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowRightIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";

type ToolCatalogueCardFaceProps = {
  badges: ReactNode;
  description: ReactNode;
  icon: ReactNode;
  render?: (props: { children: ReactNode; className: string }) => ReactElement;
  title: ReactNode;
};

const renderPendingCard = ({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) => (
  <div aria-hidden="true" className={className}>
    {children}
  </div>
);

export const ToolCatalogueCardFace = ({
  badges,
  description,
  icon,
  render = renderPendingCard,
  title,
}: ToolCatalogueCardFaceProps) =>
  render({
    className:
      "bg-background group shadow-floating flex min-h-32 items-start gap-4 rounded-xl p-4 text-start",
    children: (
      <>
        {icon}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-7 items-start gap-2">
            {title}
            <span className="ms-auto flex shrink-0 transition-opacity group-hover:opacity-70">
              <DirectionalIcon
                className="text-muted-foreground"
                icon={ArrowRightIcon}
              />
            </span>
          </div>
          {description}
          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
            {badges}
          </div>
        </div>
      </>
    ),
  });

export const ToolCatalogueCardPending = () => (
  <ToolCatalogueCardFace
    badges={
      <>
        <Skeleton className="h-5 w-12" />
        <Skeleton className="h-5 w-16" />
      </>
    }
    description={<Skeleton className="mt-1.5 h-4 w-4/5" />}
    icon={<Skeleton className="size-10 shrink-0 rounded-lg" />}
    title={<Skeleton className="h-4 w-32" />}
  />
);
