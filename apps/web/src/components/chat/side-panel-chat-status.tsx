import { useTranslations } from "use-intl";

import { CheckIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { cn } from "@stll/ui/utils";

import {
  SIDE_PANEL_CHAT_STATUS,
  SIDE_PANEL_CHAT_STATUS_LABELS,
} from "@/components/chat/side-panel-chat-status.logic";
import type { SidePanelChatStatus } from "@/components/chat/side-panel-chat-status.logic";

/**
 * The visible line for a chat opening in the side panel: the mark while it
 * is made, then a check and "available in the side panel", the copy
 * button's confirm-in-place applied to a sentence. Hidden from assistive
 * technology; `SidePanelChatAnnouncer` says it once.
 */
export const SidePanelChatNote = ({
  className,
  status,
}: {
  className?: string | undefined;
  status: SidePanelChatStatus;
}) => {
  const t = useTranslations();
  if (status === SIDE_PANEL_CHAT_STATUS.idle) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs",
        className,
      )}
    >
      {status === SIDE_PANEL_CHAT_STATUS.creating ? (
        <Loader size="sm" />
      ) : (
        <CheckIcon className="size-3.5 shrink-0" />
      )}
      <span className="truncate">
        {t(SIDE_PANEL_CHAT_STATUS_LABELS[status])}
      </span>
    </span>
  );
};

/**
 * A live region that stays mounted, so the status is announced even though
 * the visible note comes and goes. Visually hidden and out of the layout.
 */
export const SidePanelChatAnnouncer = ({
  status,
}: {
  status: SidePanelChatStatus;
}) => {
  const t = useTranslations();
  return (
    <span aria-live="polite" className="sr-only">
      {status === SIDE_PANEL_CHAT_STATUS.idle
        ? ""
        : t(SIDE_PANEL_CHAT_STATUS_LABELS[status])}
    </span>
  );
};
