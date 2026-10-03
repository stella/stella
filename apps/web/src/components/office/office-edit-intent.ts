import { typedCharacter } from "@stll/ui/typed-character";
import type { TypedCharacterEvent } from "@stll/ui/typed-character";

const EDIT_INTENT_KEYSTROKES_REQUIRED = 3;
const EDIT_INTENT_WINDOW_MS = 1600;
const EDIT_INTENT_PROMPT_COOLDOWN_MS = 10_000;

export type OfficeEditIntentState = {
  keystrokeTimestamps: readonly number[];
  lastPromptedAt: number | null;
};

export const INITIAL_OFFICE_EDIT_INTENT_STATE: OfficeEditIntentState = {
  keystrokeTimestamps: [],
  lastPromptedAt: null,
};

type OfficeEditIntentKey = TypedCharacterEvent & Pick<KeyboardEvent, "repeat">;

export const isOfficeEditIntentKey = (event: OfficeEditIntentKey): boolean =>
  !event.repeat && (event.isComposing || typedCharacter(event) !== null);

type RegisterOfficeEditIntentKeystrokeOptions = {
  state: OfficeEditIntentState;
  timestamp: number;
};

export const registerOfficeEditIntentKeystroke = ({
  state,
  timestamp,
}: RegisterOfficeEditIntentKeystrokeOptions): {
  state: OfficeEditIntentState;
  shouldPrompt: boolean;
} => {
  if (
    state.lastPromptedAt !== null &&
    timestamp - state.lastPromptedAt < EDIT_INTENT_PROMPT_COOLDOWN_MS
  ) {
    return { state, shouldPrompt: false };
  }

  const keystrokeTimestamps = state.keystrokeTimestamps.filter(
    (candidate) => timestamp - candidate <= EDIT_INTENT_WINDOW_MS,
  );
  keystrokeTimestamps.push(timestamp);

  if (keystrokeTimestamps.length < EDIT_INTENT_KEYSTROKES_REQUIRED) {
    return {
      state: { ...state, keystrokeTimestamps },
      shouldPrompt: false,
    };
  }

  return {
    state: { keystrokeTimestamps: [], lastPromptedAt: timestamp },
    shouldPrompt: true,
  };
};
