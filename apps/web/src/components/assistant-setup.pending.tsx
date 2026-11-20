import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";

/** The guide tile's box: one per assistant, side by side. */
export const ASSISTANT_GUIDE_TILE_CLASS =
  "bg-muted/60 text-foreground hover:bg-muted flex min-h-11 flex-1 items-center justify-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-medium";

/** The row holding the server address and its copy button. */
export const ASSISTANT_ADDRESS_ROW_CLASS =
  "bg-muted flex items-center gap-2 rounded-lg py-1 ps-3 pe-1";

/** The id the card's heading carries, which names the card. */
const ASSISTANT_SETUP_TITLE_ID = "assistant-setup-title";

/**
 * The assistant setup's card (`AssistantSetup`, `card` variant) in both
 * phases: the surface and its heading over the body.
 */
export const AssistantSetupCard = ({ children }: { children: ReactNode }) => (
  <section
    aria-labelledby={ASSISTANT_SETUP_TITLE_ID}
    className="bg-background ring-border flex flex-col gap-3 rounded-xl p-5 shadow-xs/5 ring-1"
  >
    <h2
      className="text-foreground text-base font-medium text-balance"
      id={ASSISTANT_SETUP_TITLE_ID}
    >
      <PendingText barClassName="w-48" id="agentSetup.title" />
    </h2>
    {children}
  </section>
);

/** The assistants a guide tile names, in order (brand names, not copy). */
const GUIDE_TILES_PENDING = [{ name: "Claude" }, { name: "ChatGPT" }] as const;

/**
 * The card in a pending phase: the line, the guide tiles with their names,
 * the address row with a bar where the address goes and the copy button's
 * face, and the hint line.
 */
export const AssistantSetupPending = () => (
  <AssistantSetupCard>
    <div aria-hidden="true" className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm text-pretty">
        <PendingText
          barClassName="w-96 max-w-full"
          id="agentSetup.description"
        />
      </p>
      <div className="flex gap-3">
        {GUIDE_TILES_PENDING.map(({ name }) => (
          <span className={ASSISTANT_GUIDE_TILE_CLASS} key={name}>
            <span className="size-5" />
            {name}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">
          <PendingText barClassName="w-24" id="agentSetup.addressLabel" />
        </span>
        <div className={ASSISTANT_ADDRESS_ROW_CLASS}>
          <span className="flex-1 font-mono text-sm">
            <FaceLabelPending className="w-56 max-w-full" />
          </span>
          <ButtonFace size="sm" variant="default">
            <FaceLabelPending className="w-10" />
          </ButtonFace>
        </div>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span>
          <PendingText barClassName="w-48" id="agentSetup.selfSetupHint" />
        </span>
        <ButtonFace size="xs" variant="link">
          <PendingText barClassName="w-10" id="agentSetup.copy" />
        </ButtonFace>
        <span>
          <PendingText barClassName="w-32" id="agentSetup.pasteHint" />
        </span>
      </div>
    </div>
  </AssistantSetupCard>
);
