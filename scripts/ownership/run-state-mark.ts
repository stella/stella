import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "run-state-mark",
  capability:
    "Drawing a run state: a chat waiting on the reader, a chat working",
  owner: [
    "packages/ui/src/components/run-state-mark.shared.ts",
    "packages/ui/src/components/run-state-mark.tsx",
    "packages/ui/src/components/run-state-mark.native.tsx",
  ],
  summary:
    "`RUN_STATE_MARKS` gives each state the API reports " +
    "(`CHAT_ACTIVE_RUN_STATE`) its glyph and tone: a bold warning `!` while " +
    "a run waits on the reader, `StatusMark`'s turning ring in the muted " +
    "foreground while it works. `RunStateMark` draws it on the web and, " +
    "through the `react-native` export condition, on the phone, so the " +
    "web sidebar and the phone's chat list share one look.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-hand-drawn-run-state/no-hand-drawn-run-state",
    reason:
      "Drawing a state is branching on it and rendering or colouring in the " +
      "branch; no import names it.",
  },
} as const satisfies OwnershipEntry;
