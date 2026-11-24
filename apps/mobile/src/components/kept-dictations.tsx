import { createContext, use, useEffect, useState } from "react";

import { panic } from "better-result";
import { randomUUID } from "expo-crypto";
import { AppState } from "react-native";

import { applyLearnedFixes } from "@stll/transcript/corrections";
import { respell } from "@stll/transcript/spelling";

import {
  finalText,
  transcribePiece,
} from "@/components/dictation-transcription";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { deviceAccountStore } from "@/native/account-store";
import { watchNetwork } from "@/native/dictation-device";
import {
  forgetKeptDictation,
  keepDictation,
  keptRecordingUri,
  listKeptDictations,
  removeKeptRecording,
  updateKeptDictation,
} from "@/native/kept-dictation-files";
import { readMatterVocabulary } from "@/state/dictation";
import { joinChunks } from "@/state/dictation-chunks";
import {
  recordingsToTranscribe,
  retriesByItself,
  transcribedTexts,
  withTranscribed,
} from "@/state/dictation-kept";
import { readLearnedFixes } from "@/state/dictation-learned";
import { readDictationChoice } from "@/state/dictation-preferences";
import type { DictationPreferences } from "@/state/dictation-preferences";
import { createKeptDictations } from "@/state/kept-dictations";
import type {
  KeptDictations,
  RetryOutcome,
  WaitingDictation,
} from "@/state/kept-dictations";

const KeptDictationsContext = createContext<KeptDictations | null>(null);

/**
 * The signed-in account's kept dictations (`state/kept-dictations`), for
 * every dictation field under it: read from the phone as the account opens,
 * retried as the phone comes online or back to the front, and dropped with
 * the account. Signed out, fields keep nothing.
 */
export const KeptDictationsProvider = ({
  children,
}: React.PropsWithChildren) => {
  const { state } = useSession();
  const session =
    state.status === "signed-in" ? state.source.session() : undefined;
  if (state.status !== "signed-in" || session === undefined) {
    return (
      <KeptDictationsContext value={null}>{children}</KeptDictationsContext>
    );
  }
  return (
    // Each sign-in has its own token source, so its own store.
    <AccountKeptDictations
      key={`${session.serverUrl} ${session.userId} ${session.signInId}`}
      account={{ serverUrl: session.serverUrl, userId: session.userId }}
      source={state.source}
    >
      {children}
    </AccountKeptDictations>
  );
};

/** The kept dictations of the account signed in now; null signed out. */
export const useKeptDictations = (): KeptDictations | null =>
  use(KeptDictationsContext);

const AccountKeptDictations = ({
  account,
  children,
  source,
}: React.PropsWithChildren<{
  account: { readonly serverUrl: string; readonly userId: string };
  source: AccessTokenSource;
}>) => {
  const [store] = useState(() =>
    createKeptDictations({
      account,
      files: {
        list: listKeptDictations,
        keep: keepDictation,
        update: updateKeptDictation,
        removeRecording: removeKeptRecording,
        forget: forgetKeptDictation,
      },
      retry: async (kept) => await retryKept(source, kept),
      now: epochMilliseconds,
      later: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
      newId: randomUUID,
    }),
  );

  useEffect(() => {
    // What an earlier run kept that cannot be listed stays on the phone for
    // the next launch to find.
    void (async () => {
      await store.load();
      await store.retryWaiting();
    })();
    const foreground = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        void store.retryWaiting();
      }
    });
    const network = watchNetwork((online) => {
      if (online) {
        void store.retryWaiting();
      }
    });
    return () => {
      foreground.remove();
      network?.remove();
      store.stop();
    };
  }, [store]);

  return (
    <KeptDictationsContext value={store}>{children}</KeptDictationsContext>
  );
};

/**
 * Transcribes a kept dictation's recordings that have no text yet, with
 * the model, matter and cleanup it was recorded with; the matter's names
 * are read again, as they may have grown since. One refused for its model
 * goes with the model picked now (`modelFor`).
 */
const retryKept = async (
  source: AccessTokenSource,
  kept: WaitingDictation,
): Promise<RetryOutcome> => {
  const vocabulary =
    kept.matterId === null
      ? []
      : (
          await readMatterVocabulary({ fetch, source, matterId: kept.matterId })
        ).unwrapOr([]);
  const model = await modelFor(source, kept);
  const choice = {
    modelId: model.modelId ?? undefined,
    modelClass: model.modelClass,
    matterId: kept.matterId ?? undefined,
    vocabulary,
  };
  const outcomes = await Promise.all(
    recordingsToTranscribe(kept.state.pieces).map(async (file) => ({
      file,
      result: await transcribePiece({
        source,
        uri: keptRecordingUri(kept.id, file),
        choice,
      }),
    })),
  );
  const texts = new Map(
    outcomes.flatMap(({ file, result }) =>
      result.isOk() ? [[file, result.value] as const] : [],
    ),
  );
  const pieces = withTranscribed(kept.state.pieces, texts);
  const all = transcribedTexts(pieces);
  if (all === null) {
    const failures = outcomes.flatMap(({ result }) =>
      result.isErr() ? [result.error] : [],
    );
    // One refused recording makes the dictation wait for the person, as
    // retrying by itself would send it again and again.
    const error =
      failures.find((failure) => !retriesByItself(failure)) ?? failures.at(0);
    if (error === undefined) {
      return panic("A recording was left without text and without a failure");
    }
    return { type: "failed", pieces, error };
  }
  const joined = joinChunks(all);
  if (joined === "") {
    return { type: "silent" };
  }
  const text = await finalText({
    source,
    cleanup: kept.cleanup,
    style: kept.style,
    translateTo: kept.translateTo,
    joined,
    locale: kept.locale,
  });
  const session = source.session();
  // Fixes the phone cannot read are not applied; the text stays as heard.
  const learned =
    session === undefined
      ? []
      : await readLearnedFixes(deviceAccountStore, session).catch(() => []);
  return {
    type: "transcribed",
    dictated: {
      text: respell(applyLearnedFixes(text, learned), vocabulary),
      names: vocabulary,
    },
  };
};

/**
 * The model a retry names: the one the dictation was recorded with, or,
 * for one refused because that model is no longer offered, the one the
 * person has picked since, as the refusal told them to.
 */
const modelFor = async (
  source: AccessTokenSource,
  kept: WaitingDictation,
): Promise<Pick<DictationPreferences, "modelId" | "modelClass">> => {
  const session = source.session();
  if (kept.state.refusedFor !== "model" || session === undefined) {
    return { modelId: kept.modelId, modelClass: kept.modelClass };
  }
  // Choices the phone cannot read keep the dictation's own model, which the
  // server refuses again: never the default in their place.
  const { modelId, modelClass } = (
    await readDictationChoice(deviceAccountStore, session)
  ).unwrapOr({ modelId: kept.modelId, modelClass: kept.modelClass });
  return { modelId, modelClass };
};
