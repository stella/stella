import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Popover, PopoverPopup } from "@stll/ui/components/popover";

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
  return (
    <>
      <p className="text-muted-foreground text-xs">
        {t("workspaces.referenceConventionHint", { example })}
      </p>
      {error ? (
        <p className="text-destructive mt-1 text-xs">{error}</p>
      ) : showWarning ? (
        <p className="mt-1 text-xs text-amber-600">
          {t("workspaces.referenceFormatWarning")}
        </p>
      ) : null}
    </>
  );
};

type InlineProps = {
  variant: "inline";
  value: string;
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
    return (
      <div className="mt-1">
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
