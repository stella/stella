import { useEffect, useRef } from "react";

import type {
  NativeSyntheticEvent,
  TextInputSelectionChangeEventData,
} from "react-native";
import { useLocale } from "use-intl";

import { insertDictation } from "@/state/dictation";
import type { Dictated, TextSelection } from "@/state/dictation";

/**
 * A text field that takes dictation where its cursor is. Spread
 * `inputProps` on the field, which reports what is typed through them, and
 * hand `insert` to the microphone. The cursor counts only while the field
 * holds what was last typed or dictated into it: text the screen put there
 * since, as a sent message's empty box, takes dictation at its end.
 */
export const useDictationField = (
  value: string,
  onChangeText: (text: string) => void,
) => {
  const locale = useLocale();
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  // The field's text as last typed or dictated, and its cursor then.
  const cursor = useRef<{ text: string; selection: TextSelection | undefined }>(
    { text: value, selection: undefined },
  );

  return {
    inputProps: {
      onChangeText: (text: string) => {
        cursor.current = { ...cursor.current, text };
        onChangeText(text);
      },
      onSelectionChange: ({
        nativeEvent: { selection },
      }: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        cursor.current = { ...cursor.current, selection };
      },
    },
    insert: (dictated: Dictated) => {
      const draft = latest.current;
      const { text, caret } = insertDictation({
        draft,
        selection:
          cursor.current.text === draft ? cursor.current.selection : undefined,
        dictated,
        locale,
      });
      cursor.current = { text, selection: { start: caret, end: caret } };
      latest.current = text;
      onChangeText(text);
    },
  };
};
