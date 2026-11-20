import { ButtonFace } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";

/**
 * A labelled `CopyControl`'s face (`@/components/copy-control`) at the default
 * size: the button box, the glyph's cell at its size, and the Copy and
 * Copied labels sharing one cell as the live control stacks them, so the
 * control that loads keeps the wider label's width. The glyph itself is
 * `CopyButton`'s alone (it turns into a check in place), so the face keeps
 * only its box.
 */
export const CopyControlFace = ({
  variant,
}: {
  variant: "outline" | "ghost";
}) => (
  <ButtonFace size="default" variant={variant}>
    <span className="grid place-items-center">
      <span className="col-start-1 row-start-1 size-3.5" />
    </span>
    <span className="grid">
      <span className="col-start-1 row-start-1">
        <PendingText barClassName="w-8" id="common.copy" />
      </span>
      <span className="col-start-1 row-start-1 opacity-0">
        <PendingText barClassName="w-10" id="common.copied" />
      </span>
    </span>
  </ButtonFace>
);
