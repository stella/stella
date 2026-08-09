import { LaptopIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import {
  type DesktopOpenTarget,
  useDesktopFileOpen,
} from "@/components/inspector/use-desktop-file-open";
import Tooltip from "@/components/tooltip";
import { detached } from "@/lib/detached";

export const DesktopOpenButton = ({
  entityId,
  fieldId,
  fileType,
  propertyId,
  workspaceId,
}: DesktopOpenTarget & { fieldId: string }) => {
  const t = useTranslations();
  const label = t("workspaces.files.desktopEdit.openAction");
  const { isOpening, open } = useDesktopFileOpen(
    { entityId, fileType, propertyId, workspaceId },
  );
  const desktopOpenAttention = useInspectorCommandStore(
    (state) => state.desktopOpenAttention,
  );
  const clearDesktopOpenAttention = useInspectorCommandStore(
    (state) => state.clearDesktopOpenAttention,
  );
  const attentionSequence =
    desktopOpenAttention?.fieldId === fieldId
      ? desktopOpenAttention.sequence
      : null;

  return (
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          className={cn(
            "transition-[color,background-color,box-shadow]",
            attentionSequence !== null &&
              "bg-primary/10 text-primary ring-primary/60 animate-[pulse_700ms_ease-in-out_3] ring-2 motion-reduce:animate-none",
          )}
          disabled={isOpening}
          key={attentionSequence ?? "idle"}
          onClick={() => {
            detached(open(), "DesktopOpenButton");
          }}
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget) {
              return;
            }
            if (attentionSequence !== null) {
              clearDesktopOpenAttention(attentionSequence);
            }
          }}
          size="icon-xs"
          variant="ghost"
        >
          <LaptopIcon
            className={cn("size-3.5", isOpening && "animate-pulse")}
          />
        </Button>
      }
    />
  );
};
