import { OutcomePage } from "./outcome-screen-core";
import type { OutcomeContentProps } from "./outcome-screen-core";

/** The page outcome before its interactive behavior mounts. */
export const OutcomeScreenFace = (
  props: Pick<
    OutcomeContentProps,
    "actions" | "description" | "title" | "tone"
  >,
) => <OutcomePage {...props} />;
