import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

import { matchesPattern, previewReference } from "@/lib/matter-reference";
import { organizationSettingsOptions } from "@/routes/_protected.organization/-settings-queries";

type MatterNumberHintBodyProps = {
  example: string;
  showWarning: boolean;
  error?: string | undefined;
};

const MatterNumberHintBody = ({
  example,
  showWarning,
  error,
}: MatterNumberHintBodyProps) => {
  const t = useTranslations();

  if (error) {
    return <p className="text-destructive text-xs">{error}</p>;
  }

  if (showWarning) {
    return (
      <div className="space-y-1 text-xs">
        <p className="text-muted-foreground">
          {t("workspaces.referenceConventionHint", { example })}
        </p>
        <p className="text-amber-600">
          {t("workspaces.referenceFormatWarning")}
        </p>
        <Link
          className="text-foreground inline-flex text-xs font-medium hover:underline"
          to="/settings/organization/matter-numbering"
        >
          {t("settings.organization.matterNumbering")}
        </Link>
      </div>
    );
  }

  return (
    <p className="text-muted-foreground truncate text-xs">
      {t("workspaces.referenceConventionHint", { example })}
    </p>
  );
};

type InlineProps = {
  variant: "inline";
  value: string;
  className?: string | undefined;
  error?: string | undefined;
};

type PopoverProps = {
  variant: "popover";
  value: string;
  open: boolean;
  anchor: HTMLElement | null;
  error?: string | undefined;
};

export type MatterNumberHintProps = InlineProps | PopoverProps;

export const MatterNumberHint = (props: MatterNumberHintProps) => {
  const t = useTranslations();
  const { data: settings } = useQuery(organizationSettingsOptions);

  if (!settings) {
    return null;
  }

  const { matterNumberPattern: pattern, matterNumberPadding: padding } =
    settings;
  const example = previewReference({ pattern, padding });
  const trimmed = props.value.trim();
  const showWarning =
    trimmed.length > 0 && !matchesPattern(trimmed, pattern, padding);

  if (props.variant === "inline") {
    if (showWarning && !props.error) {
      return (
        <div className={cn("mt-1", props.className)}>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  aria-label={t("workspaces.referenceFormatWarning")}
                  className="text-amber-600 hover:text-amber-700"
                  size="icon-xs"
                  title={t("workspaces.referenceFormatWarning")}
                  variant="ghost"
                />
              }
            >
              <AlertTriangleIcon className="size-3.5" />
            </PopoverTrigger>
            <PopoverPopup align="start" className="w-72" side="bottom">
              <MatterNumberHintBody
                example={example}
                showWarning={showWarning}
              />
            </PopoverPopup>
          </Popover>
        </div>
      );
    }

    return (
      <div className={cn("mt-1", props.className)}>
        <MatterNumberHintBody
          error={props.error}
          example={example}
          showWarning={showWarning}
        />
      </div>
    );
  }

  return (
    <Popover open={props.open}>
      <PopoverPopup
        align="start"
        anchor={props.anchor}
        className="w-auto"
        initialFocus={false}
        side="bottom"
        sideOffset={6}
      >
        <div className="px-1">
          <MatterNumberHintBody
            error={props.error}
            example={example}
            showWarning={showWarning}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
};
