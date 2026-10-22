import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { LandmarkIcon } = await import("@stll/ui/icons");
const { AttachmentChip } = await import("@/components/chat/attachment-chip");
const { ChatAttachmentChip, ChatCommandChip } =
  await import("@/components/chat/chat-draft-attachment-chips");
const { InlinePill } = await import("@/components/inline-pill");
const { CHIP_HEIGHT_CLASS, CHIP_ICON_CLASS } =
  await import("@/components/chip-scale");
const en = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const draft = {
  type: "draft",
  onExpand: () => undefined,
  onRemove: () => undefined,
} as const;

const CASE_NUMBER = "28 Co 91/2025";
const QUOTE =
  "Z obsahu spisu odvolací soud zjistil, že žalobce se domáhal zaplacení částky 43 240 Kč.";

const CHIP_KINDS = {
  "quoted text in a composer": (
    <ChatAttachmentChip
      behavior={draft}
      item={{ type: "pasted_text", id: "quote", text: QUOTE }}
    />
  ),
  "quoted text in a sent message": (
    <ChatAttachmentChip
      behavior={{ type: "sent" }}
      item={{ type: "pasted_text", id: "quote", text: QUOTE }}
    />
  ),
  "pasted screenshot": (
    <ChatAttachmentChip
      behavior={draft}
      item={{
        type: "file",
        id: "screenshot",
        filename: "Snímek obrazovky 2026-10-22.png",
        mimeType: "image/png",
      }}
    />
  ),
  "attached file": (
    <ChatAttachmentChip
      behavior={draft}
      item={{
        type: "file",
        id: "file",
        filename: "Rozsudek 28 Co 91/2025.pdf",
        mimeType: "application/pdf",
      }}
    />
  ),
  "file in a sent message": (
    <AttachmentChip
      icon={({ className }) => <LandmarkIcon className={className} />}
      kind="file"
      open={{ type: "link", href: "https://example.test/rozsudek.pdf" }}
      title="Rozsudek 28 Co 91/2025.pdf"
    />
  ),
  "slash command": <ChatCommandChip label="/new" />,
  "case reference": (
    <InlinePill
      leadingIcon={<LandmarkIcon className={CHIP_ICON_CLASS} />}
      truncate
    >
      {CASE_NUMBER}
    </InlinePill>
  ),
};

// Classes that set an element's block size. A chip draws its height from the
// scale alone; anything else inside it would let one kind outgrow another.
const SIZING_CLASS =
  /^(?:[a-z-]+:)*(?:(?:h|min-h|size|py|pt|pb|p|leading)-|text-(?:sm|base|lg|[2-9]?xl)$)/u;
const SCALE_CLASSES = new Set([CHIP_HEIGHT_CLASS, "size-3", "size-4"]);

const renderChip = (chip: ReactNode) =>
  render(
    <IntlProvider locale="en" messages={en}>
      <TooltipProvider>{chip}</TooltipProvider>
    </IntlProvider>,
  );

for (const [kind, chip] of Object.entries(CHIP_KINDS)) {
  test(`a ${kind} chip draws its height from the chip scale only`, () => {
    const view = renderChip(chip);
    const shell = view.container.querySelector<HTMLElement>("[data-chip-kind]");
    expect(shell).not.toBeNull();
    if (shell === null) {
      return;
    }
    expect(shell.classList.contains(CHIP_HEIGHT_CLASS)).toBe(true);
    const offending = [shell, ...shell.querySelectorAll("*")].flatMap(
      (element) =>
        [...element.classList].filter(
          (name) => SIZING_CLASS.test(name) && !SCALE_CLASSES.has(name),
        ),
    );
    expect(offending).toEqual([]);
  });
}
