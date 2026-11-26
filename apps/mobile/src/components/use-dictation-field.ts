import { useRef, useState } from "react";

import { randomUUID } from "expo-crypto";
import type { TextInputSelectionChangeEvent } from "react-native";
import { useLocale } from "use-intl";

import { editsOf, learnedFixChangesOf } from "@stll/transcript/corrections";
import type { DictatedSpan } from "@stll/transcript/corrections";
import { applyLearnedFixChanges } from "@stll/transcript/learned-fixes";
import type { LearnedFixChange } from "@stll/transcript/learned-fixes";
import { useLatest } from "@stll/ui/effects";

import { syncLearned } from "@/components/learned-fixes-sync";
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
 * `learnOnceSent` learns how the person corrected what was dictated in the
 * text sent or saved (`@stll/transcript/corrections`), on this phone and,
 * once synced, on their other devices.
 */
export const useDictationField = (
  value: string,
  onChangeText: (text: string) => void,
) => {
  const locale = useLocale();
  const { state } = useSession();
  const latestRef = useLatest(value);
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
      const draft = latestRef.current;
      const { text, start, caret } = insertDictation({
        draft,
        selection:
          cursor.current.text === draft ? cursor.current.selection : undefined,
        dictated,
        locale,
      });
      cursor.current = { text, selection: { start: caret, end: caret } };
      latestRef.current = text;
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
        if (dictated.length === 0 || state.status !== "signed-in") {
          return;
        }
        const { source } = state;
        const session = source.session();
        if (session === undefined) {
          return;
        }
        updateLearnedFixes(deviceAccountStore, session, randomUUID, (fixes) => {
          let learned = fixes;
          const changes: LearnedFixChange[] = [];
          for (const span of dictated) {
            const taught = learnedFixChangesOf(learned, editsOf(span, final));
            learned = applyLearnedFixChanges(learned, taught);
            changes.push(...taught);
          }
          return changes;
        })
          .then(async () => await syncLearned(source))
          .catch(() => undefined);
      };
    },
  };
};
