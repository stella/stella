import { Button } from "@stll/ui/button";
import { LaptopIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { cn } from "@stll/ui/utils";

import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import {
  type DesktopOpenTarget,
  useDesktopFileOpen,
} from "@/components/inspector/use-desktop-file-open";
import {
  DesktopRequiredDialog,
  useDesktopActionGate,
} from "@/features/desktop/desktop-action-gate";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";

const DESKTOP_OPEN_ATTENTION_TIMEOUT_MS = 2500;

type DesktopOpenButtonProps = DesktopOpenTarget & { fieldId: string };

export const DesktopOpenButton = ({
  entityId,
  fieldId,
  fileType,
  propertyId,
  workspaceId,
}: DesktopOpenButtonProps) => {
  const gate = useDesktopActionGate("edit-file");
  const { label } = gate;
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
    <>
      <CapabilityAction action={{ capability: "desktop" }} surface="control">
        {(capabilityProps) => (
          <Button
            aria-busy={isOpening || undefined}
            aria-label={label}
            className={cn(
              attentionSequence !== null &&
                "bg-primary/10 text-primary ring-primary/60 animate-[pulse_700ms_ease-in-out_3] ring-2 motion-reduce:animate-none",
            )}
            disabled={isOpening}
            key={attentionSequence ?? "idle"}
            onClick={() => {
              gate.run(() => {
                detached(open(), "desktop-open-button.open");
              });
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
            {...capabilityProps}
          >
            {isOpening ? (
              <Loader className="size-3.5" size="sm" variant="decorative" />
            ) : (
              <LaptopIcon className="size-3.5" />
            )}
          </Button>
        )}
      </CapabilityAction>
      <DesktopRequiredDialog {...gate.requiredDialog} />
    </>
  );
};
