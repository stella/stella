import { useEffect, useRef, useState } from "react";

import type { TextInputSelectionChangeEvent } from "react-native";
import { useLocale } from "use-intl";

import { editsOf, learnFrom } from "@stll/transcript/corrections";
import type { DictatedSpan } from "@stll/transcript/corrections";

import { useSession } from "@/connection/session-provider";
import { deviceAccountStore } from "@/native/account-store";
import { insertDictation } from "@/state/dictation";
import type { Dictated, TextSelection } from "@/state/dictation";
import { readLearnedFixes, writeLearnedFixes } from "@/state/dictation-learned";

/**
 * A text field that takes dictation where its cursor is. Spread
 * `inputProps` on the field, which reports what is typed through them, and
 * hand `insert` to the microphone. The cursor counts only while the field
 * holds what was last typed or dictated into it: text the screen put there
 * since, as a sent message's empty box, takes dictation at its end. After
 * a dictation the field's cursor is put after the dictated text, once: the
 * next selection the field reports hands the cursor back to the person.
 * Call `learn` with the text sent or saved: how the person corrected what
 * was dictated is learned on this phone (`@stll/transcript/corrections`).
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
     * The field's text went out as `final`: what the person did to each
     * dictation in it is learned, best effort. A phone that cannot keep it
     * learns nothing this time; the text went out either way.
     */
    learn: (final: string) => {
      const dictated = spans.current;
      spans.current = [];
      const session =
        state.status === "signed-in" ? state.source.session() : undefined;
      if (dictated.length === 0 || session === undefined) {
        return;
      }
      learnFromSpans({ session, dictated, final }).catch(() => undefined);
    },
  };
};

/** Adds what the person did to each dictation to the fixes the phone keeps. */
const learnFromSpans = async ({
  session,
  dictated,
  final,
}: {
  session: { readonly serverUrl: string; readonly userId: string };
  dictated: readonly DictatedSpan[];
  final: string;
}) => {
  const fixes = await readLearnedFixes(deviceAccountStore, session);
  let learned = fixes;
  for (const span of dictated) {
    learned = learnFrom(learned, editsOf(span, final));
  }
  if (JSON.stringify(learned) !== JSON.stringify(fixes)) {
    await writeLearnedFixes(deviceAccountStore, session, learned);
  }
};
