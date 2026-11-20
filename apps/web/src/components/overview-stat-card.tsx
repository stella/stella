import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { TruncatedText } from "@stll/ui/truncated-text";

import {
  STAT_CARD_BOX_CLASS,
  STAT_CARD_BUTTON_BOX_CLASS,
  StatCardContent,
} from "@/components/overview-stat-card.pending";
import type { StatCardLabel } from "@/components/overview-stat-card.pending";

type StatCardProps = {
  icon: ReactNode;
  label: StatCardLabel;
  value: ReactNode;
  sublabel?: string | undefined;
  onClick?: () => void;
};

export const StatCard = ({
  icon,
  label,
  value,
  sublabel,
  onClick,
}: StatCardProps) => {
  const t = useTranslations();
  const content = (
    <StatCardContent
      icon={icon}
      label={t(label)}
      sublabel={
        sublabel ? (
          <TruncatedText className="text-muted-foreground text-xs">
            {sublabel}
          </TruncatedText>
        ) : undefined
      }
      value={value}
    />
  );

  if (onClick) {
    return (
      // The clickable card draws the same card as the static one below and
      // only adds a hover tint, so a row of stats reads as one set.
      <Button className="block min-w-0" onClick={onClick} variant="plain">
        <span className={STAT_CARD_BUTTON_BOX_CLASS}>{content}</span>
      </Button>
    );
  }

  return <div className={STAT_CARD_BOX_CLASS}>{content}</div>;
};
