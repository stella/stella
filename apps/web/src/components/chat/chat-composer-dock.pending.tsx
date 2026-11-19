import type { ReactNode } from "react";

import { COMPOSER_STATUS_ROW_CENTERED_CLASS } from "@stll/ui/composer-tokens";
import { buttonFaceClassName, FaceLabelPending } from "@stll/ui/control-face";
import { GlobeIcon, ShieldIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { ChatContextMeterPending } from "@/components/chat/chat-context-meter.pending";

/*
 * The chat composer's status row (`ChatComposerDock`) before its thread is
 * read: its clusters at their places, the controls that need no data (the
 * web search and anonymize toggles, the context ring) in their faces, and a
 * bar where the model chip's label goes. The live row lays its clusters out
 * through the same classes.
 */

/** The row's start cluster: the leading context, then the toggles. */
export const CHAT_COMPOSER_DOCK_START_CLASS =
  "flex min-w-0 flex-1 items-center gap-1";

/** The row's end cluster: new chat, the model chips, the context meter. */
export const CHAT_COMPOSER_DOCK_END_CLASS = "flex min-w-0 items-center gap-0.5";

/**
 * A status-row toggle's face (web search, anonymize): the `icon-xs` ghost
 * button, muted at rest, as the toggles restyle it.
 */
const DockToggleFace = ({ icon }: { icon: ReactNode }) => (
  <span
    aria-hidden="true"
    className={cn(
      buttonFaceClassName({ size: "icon-xs", variant: "ghost" }),
      "text-muted-foreground hover:text-foreground",
    )}
  >
    {icon}
  </span>
);

/**
 * The model chip while the choice it shows is not known yet: the chip's box
 * (the `xs` ghost button, muted, as the chip restyles it) with a bar where
 * its label goes, never a label it may have to take back.
 */
export const ChatComposerChipsPending = () => (
  <span
    aria-hidden="true"
    className={cn(
      buttonFaceClassName({ size: "xs", variant: "ghost" }),
      "text-muted-foreground hover:text-foreground gap-1.5",
    )}
    data-composer-chip="pending"
  >
    <FaceLabelPending className="w-7" />
  </span>
);

/** The status row under the chat bar before the thread is read. */
export const ChatComposerDockPending = ({
  leadingContext,
}: {
  leadingContext: ReactNode;
}) => (
  <div aria-hidden="true" className={COMPOSER_STATUS_ROW_CENTERED_CLASS}>
    <div className="flex min-w-0 items-center">
      <div
        className={CHAT_COMPOSER_DOCK_START_CLASS}
        data-slot="chat-composer-dock"
        data-status="pending"
      >
        {leadingContext}
        <DockToggleFace icon={<GlobeIcon className="size-3.5" />} />
        <span className="inline-flex">
          <DockToggleFace icon={<ShieldIcon className="size-3.5" />} />
        </span>
      </div>
    </div>
    <div className="flex items-center justify-center" />
    <div className="flex min-w-0 items-center justify-end">
      <div className={CHAT_COMPOSER_DOCK_END_CLASS}>
        <ChatComposerChipsPending />
        <ChatContextMeterPending />
      </div>
    </div>
  </div>
);
