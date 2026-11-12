import { panic } from "better-result";

import { cn } from "../lib/utils";
import {
  RUN_MARK_SIZES,
  RUN_MARK_TONES,
  RUN_STATE_MARKS,
  type RunStateMarkContract,
} from "./run-state-mark.shared";
import { StatusMark } from "./status-mark";

/**
 * Where one run of work stands, as a glyph: a bold "!" when it waits on the
 * reader, a turning ring while it works (./run-state-mark.shared.ts). Its
 * meaning is named by the element around it.
 */
export const RunStateMark = ({ size = "row", state }: RunStateMarkContract) => {
  const { glyph, tone } = RUN_STATE_MARKS[state];
  const { glyphClass, markClass } = RUN_MARK_SIZES[size];
  const { textClass } = RUN_MARK_TONES[tone];
  switch (glyph) {
    case "attention":
      return (
        <span
          aria-hidden
          className={cn(textClass, glyphClass, "leading-none font-bold")}
          data-slot="run-state-mark"
        >
          !
        </span>
      );
    case "running":
      return (
        <StatusMark className={cn(textClass, markClass)} status="running" />
      );
    default:
      glyph satisfies never;
      return panic("Unhandled run mark glyph");
  }
};

export type { RunMarkSize, RunMarkState } from "./run-state-mark.shared";
