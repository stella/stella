import { ThinkingOrb } from "thinking-orbs";
import type { OrbState } from "thinking-orbs";

type ChatActivityOrbProps = {
  state: OrbState;
};

const INLINE_ORB_SIZE = 20;
const DETAILED_ORB_SIZE = 64;

export const ChatActivityOrb = ({ state }: ChatActivityOrbProps) => {
  const usesDetailedPreset = state === "solving";

  return (
    <ThinkingOrb
      aria-hidden="true"
      className="shrink-0 opacity-70"
      data-chat-activity={state}
      role="presentation"
      size={usesDetailedPreset ? DETAILED_ORB_SIZE : INLINE_ORB_SIZE}
      state={state}
      {...(usesDetailedPreset
        ? { style: { height: INLINE_ORB_SIZE, width: INLINE_ORB_SIZE } }
        : {})}
    />
  );
};
