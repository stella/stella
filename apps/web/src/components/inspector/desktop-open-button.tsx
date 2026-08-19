import { LaptopIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import {
  type DesktopOpenTarget,
  useDesktopFileOpen,
} from "@/components/inspector/use-desktop-file-open";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";

const DESKTOP_OPEN_ATTENTION_TIMEOUT_MS = 2500;

type DesktopOpenButtonProps = DesktopOpenTarget & { fieldId: string };

export const DesktopOpenButton = ({
  entityId,
  fieldId,
  fileType,
  propertyId,
  workspaceId,
}: DesktopOpenButtonProps) => {
  const t = useTranslations();
  const label = t("workspaces.files.desktopEdit.openAction");
  const target = {
    entityId,
    fileType,
    propertyId,
    workspaceId,
  } satisfies DesktopOpenTarget;
  const { isOpening, open } = useDesktopFileOpen(target);
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

  useExternalSyncEffect(() => {
    if (attentionSequence === null) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      clearDesktopOpenAttention(attentionSequence);
    }, DESKTOP_OPEN_ATTENTION_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [attentionSequence, clearDesktopOpenAttention]);

  return (
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
        detached(open(), "desktop-open-button.open");
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
      tooltip={label}
      variant="ghost"
    >
      <LaptopIcon className={cn("size-3.5", isOpening && "animate-pulse")} />
    </Button>
  );
};
