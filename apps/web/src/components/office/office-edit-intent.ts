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

type OfficeEditIntentKey = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "isComposing" | "key" | "metaKey" | "repeat"
>;

export const isOfficeEditIntentKey = (event: OfficeEditIntentKey): boolean => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) {
    return false;
  }
  return event.key.length === 1 || event.isComposing;
};

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
