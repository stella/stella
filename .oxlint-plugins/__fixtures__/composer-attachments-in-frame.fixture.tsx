// Passive regression fixture for
// `composer-attachments-in-frame/composer-attachments-in-frame`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { ChatDraftAttachmentChips } from "@/components/chat/chat-draft-attachment-chips";
import { ComposerFrame } from "@stll/ui/composer-frame";

const files: never[] = [];
const noop = () => undefined;
const enabled = files.length > 0;

// --- Flagged: chips the surface lays out itself ---
export const _floatingTray = () => (
  <ComposerFrame
    above={
      <div className="absolute inset-x-1 bottom-full mb-2">
        {/* oxlint-disable-next-line composer-attachments-in-frame/composer-attachments-in-frame */}
        <ChatDraftAttachmentChips files={files} onExpand={noop} onRemove={noop} />
      </div>
    }
    empty
    ring="none"
    stature="compact"
    text={null}
  />
);
export const _besideFrame = () => (
  <div className="flex flex-col">
    {/* oxlint-disable-next-line composer-attachments-in-frame/composer-attachments-in-frame */}
    <ChatDraftAttachmentChips files={files} onExpand={noop} onRemove={noop} />
    <ComposerFrame ring="none" stature="large" text={null} />
  </div>
);
export const _wrappedInSlot = () => (
  <ComposerFrame
    attachments={
      <div className="px-2">
        {/* oxlint-disable-next-line composer-attachments-in-frame/composer-attachments-in-frame */}
        <ChatDraftAttachmentChips files={files} onExpand={noop} onRemove={noop} />
      </div>
    }
    ring="none"
    stature="large"
    text={null}
  />
);

// --- Allowed: the frame's own slot ---
export const _inSlot = () => (
  <ComposerFrame
    attachments={
      // expect-clean: composer-attachments-in-frame/composer-attachments-in-frame
      <ChatDraftAttachmentChips files={files} onExpand={noop} onRemove={noop} />
    }
    ring="none"
    stature="large"
    text={null}
  />
);
export const _inSlotBehindCondition = () => (
  <ComposerFrame
    attachments={
      enabled && (
        // expect-clean: composer-attachments-in-frame/composer-attachments-in-frame
        <ChatDraftAttachmentChips
          files={files}
          onExpand={noop}
          onRemove={noop}
        />
      )
    }
    ring="none"
    stature="large"
    text={null}
  />
);
