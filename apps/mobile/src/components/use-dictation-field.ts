import { useEffect, useRef, useState } from "react";

import type { TextInputSelectionChangeEvent } from "react-native";
import { useLocale } from "use-intl";

import { editsOf, learnFrom } from "@stll/transcript/corrections";
import type { DictatedSpan } from "@stll/transcript/corrections";

import { useSession } from "@/connection/session-provider";
import { deviceAccountStore } from "@/native/account-store";
import { insertDictation } from "@/state/dictation";
import type { Dictated, TextSelection } from "@/state/dictation";
import { updateLearnedFixes } from "@/state/dictation-learned";

/**
 * A text field that takes dictation where its cursor is. Spread
 * `inputProps` on the field, which reports what is typed through them, and
 * hand `insert` to the microphone. The cursor counts only while the field
 * holds what was last typed or dictated into it: text the screen put there
 * since, as a sent message's empty box, takes dictation at its end. After
 * a dictation the field's cursor is put after the dictated text, once: the
 * next selection the field reports hands the cursor back to the person.
 * `learnOnceSent` learns, on this phone, how the person corrected what was
 * dictated in the text sent or saved (`@stll/transcript/corrections`).
 */
export const useDictationField = (
  value: string,
  onChangeText: (text: string) => void,
) => {
  const locale = useLocale();
  const { state } = useSession();
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  // The field's text as last typed or dictated, and its cursor then.
  const cursor = useRef<{ text: string; selection: TextSelection | undefined }>(
    { text: value, selection: undefined },
  );
  const [placed, setPlaced] = useState<TextSelection>();
  // Each dictation since the last send, with the field's text right after it.
  const spans = useRef<DictatedSpan[]>([]);

  return {
    inputProps: {
      onChangeText: (text: string) => {
        cursor.current = { ...cursor.current, text };
        onChangeText(text);
      },
      onSelectionChange: ({
        nativeEvent: { selection },
      }: TextInputSelectionChangeEvent) => {
        cursor.current = { ...cursor.current, selection };
        setPlaced(undefined);
      },
      selection: placed,
    },
    insert: (dictated: Dictated) => {
      const draft = latest.current;
      const { text, start, caret } = insertDictation({
        draft,
        selection:
          cursor.current.text === draft ? cursor.current.selection : undefined,
        dictated,
        locale,
      });
      cursor.current = { text, selection: { start: caret, end: caret } };
      latest.current = text;
      if (caret > start) {
        spans.current.push({ text, start, end: caret });
      }
      onChangeText(text);
      setPlaced({ start: caret, end: caret });
    },
    /**
     * The field's text is going out as `final`: takes the dictations in it
     * now, so one made while the text is being sent is not compared with
     * it, and returns what to call once it went out. Then what the person
     * did to each dictation is learned, best effort: a phone that cannot
     * keep it learns nothing this time, and the text went out either way.
     */
    learnOnceSent: (final: string) => {
      const dictated = spans.current;
      spans.current = [];
      return () => {
        const session =
          state.status === "signed-in" ? state.source.session() : undefined;
        if (dictated.length === 0 || session === undefined) {
          return;
        }
        updateLearnedFixes(deviceAccountStore, session, (fixes) => {
          let learned = fixes;
          for (const span of dictated) {
            learned = learnFrom(learned, editsOf(span, final));
          }
          return learned;
        }).catch(() => undefined);
      };
    },
  };
};
