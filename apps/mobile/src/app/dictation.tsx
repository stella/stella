import {
  Suspense,
  use,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import { panic, Result } from "better-result";
import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { Stack, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { useFormatter, useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { Text } from "@stll/ui/text";
import { Textarea } from "@stll/ui/textarea";

import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { useKeptDictations } from "@/components/kept-dictations";
import { RetryButton } from "@/components/retry-button";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { deviceAccountStore } from "@/native/account-store";
import {
  copyText,
  discardQuickDictation,
  takeQuickDictation,
} from "@/native/quick-dictation";
import type { KeptRefusal } from "@/state/dictation-kept";
import { readLearnedFixes } from "@/state/dictation-learned";
import {
  chosenModelId,
  DEFAULT_DICTATION_PREFERENCES,
  readDictationPreferences,
} from "@/state/dictation-preferences";
import { UPLOAD_ORIGIN } from "@/state/document-upload";
import type { FinishedPiece, KeptDictations } from "@/state/kept-dictations";
import { readLocalFile } from "@/state/local-file";
import {
  dictationDocument,
  transcribeQuickDictation,
} from "@/state/quick-dictation";
import type { QuickDictationText } from "@/state/quick-dictation";

/**
 * A dictation recorded outside the app (the Action Button, Siri, Shortcuts,
 * Control Center), transcribed as the sheet opens: the text to read over and
 * correct, then save to a matter as a document, start a conversation with,
 * or copy. The recording is deleted once it is transcribed; one that could
 * not be is kept with the composer's dictations until it is.
 */
const DictationScreen = () => {
  const { state } = useSession();
  const [attempt, setAttempt] = useState(0);
  // Whether the last try failed with the recording still here: it waits for
  // a retry while the sheet is open, and goes as the sheet closes. A retry
  // remounts the loader, so this outlives each try.
  const failed = useRef(false);
  useEffect(
    () => () => {
      if (failed.current) {
        void discardQuickDictation().catch(() => undefined);
      }
    },
    [],
  );
  return state.status === "signed-in" ? (
    <DictationLoader
      key={attempt}
      onFailed={() => {
        failed.current = true;
      }}
      onRetry={() => {
        failed.current = false;
        setAttempt((count) => count + 1);
      }}
      source={state.source}
    />
  ) : null;
};

/**
 * What the sheet found: a dictation's text, or none waiting; or, as a piece
 * could not be transcribed, the dictation kept with the composer's, or,
 * when the phone could not keep it, failed for a retry here.
 */
type Reading =
  | Exclude<QuickDictationText, { type: "failed" }>
  | { readonly type: "none" }
  | {
      readonly type: "kept";
      readonly refused: boolean;
      readonly refusedFor: KeptRefusal | null;
    }
  | { readonly type: "failed"; readonly signedOut: boolean };

const DictationLoader = ({
  onFailed,
  onRetry,
  source,
}: {
  onFailed: () => void;
  onRetry: () => void;
  source: AccessTokenSource;
}) => {
  const locale = useLocale();
  const kept = useKeptDictations();
  const [reading] = useState(
    async () => await readDictation({ source, locale, kept }),
  );
  return (
    <Suspense fallback={<Transcribing />}>
      <LoadedDictation
        onFailed={onFailed}
        onRetry={onRetry}
        reading={reading}
        source={source}
      />
    </Suspense>
  );
};

const Transcribing = () => {
  const chat = useTranslations("chat");
  return (
    <View
      className="bg-background flex-1 items-center gap-3"
      style={screenStyles.content}
    >
      <Loader />
      <Text variant="caption">{chat("dictationTranscribing")}</Text>
    </View>
  );
};

const LoadedDictation = ({
  onFailed,
  onRetry,
  reading,
  source,
}: {
  onFailed: () => void;
  onRetry: () => void;
  reading: Promise<Reading>;
  source: AccessTokenSource;
}) => {
  const settings = useTranslations("settings");
  const tabs = useTranslations("tabs");
  const router = useRouter();
  const { end } = useSession();
  const read = use(reading);
  const failed = read.type === "failed";

  useEffect(() => {
    if (read.type === "failed" && read.signedOut) {
      end(source);
    }
  }, [end, read, source]);

  useEffect(() => {
    if (failed) {
      onFailed();
    }
  }, [failed, onFailed]);

  const close = () => {
    router.back();
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: settings("dictationTitle"),
          unstable_headerLeftItems: () => [
            { label: tabs("close"), onPress: close, type: "button" },
          ],
        }}
      />
      {read.type === "text" ? (
        <DictationText initial={read.text} />
      ) : (
        <View className="bg-background flex-1" style={screenStyles.content}>
          <NoText onRetry={onRetry} read={read} />
        </View>
      )}
    </>
  );
};

/** Why there is no text to read over. */
const NoText = ({
  onRetry,
  read,
}: {
  onRetry: () => void;
  read: Exclude<Reading, { type: "text" }>;
}) => {
  const t = useTranslations("quickDictation");
  const chat = useTranslations("chat");
  const settings = useTranslations("settings");
  switch (read.type) {
    case "none":
      return <EmptyCard description={t("none")} title={t("noneTitle")} />;
    case "silent":
      return (
        <EmptyCard
          description={chat("dictationSilent")}
          title={t("noneTitle")}
        />
      );
    case "kept":
      return (
        <EmptyCard
          description={chat(keptMessage(read))}
          title={settings("dictationTitle")}
        />
      );
    case "failed":
      return (
        <EmptyCard
          description={chat("dictationFailed")}
          title={settings("dictationTitle")}
        >
          <RetryButton label={chat("retry")} onPress={onRetry} />
        </EmptyCard>
      );
    default:
      read satisfies never;
      return panic("Unknown dictation reading");
  }
};

/** What a kept dictation waits for, as the composer says it. */
const keptMessage = ({
  refused,
  refusedFor,
}: Extract<Reading, { type: "kept" }>) => {
  if (refusedFor === "model") {
    return "dictationKeptModelWithdrawn";
  }
  return refused ? "dictationKeptRefused" : "dictationKept";
};

/** The text to read over, and where it can go. */
const DictationText = ({ initial }: { initial: string }) => {
  const t = useTranslations("quickDictation");
  const scan = useTranslations("scan");
  const chat = useTranslations("chat");
  const format = useFormatter();
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [copied, setCopied] = useState(false);
  const [preparing, startPreparing] = useTransition();
  const [copying, startCopying] = useTransition();
  const [failed, setFailed] = useState(false);
  const [spokenAt] = useState(epochMilliseconds);
  // The document a save prepared, deleted as the sheet closes.
  const prepared = useRef<File | null>(null);
  const empty = text.trim() === "";

  useEffect(
    () => () => {
      const file = prepared.current;
      if (file?.exists === true) {
        // Best effort: the cache folder is the system's to clear too.
        Result.try(() => {
          file.delete();
        }).unwrapOr(undefined);
      }
    },
    [],
  );

  const saveToMatter = () => {
    setFailed(false);
    startPreparing(async () => {
      const document = dictationDocument({
        text: text.trim(),
        title: t("documentName", {
          when: format.dateTime(spokenAt, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        }),
      });
      const written = await Result.tryPromise(async () => {
        const file = new File(Paths.cache, `dictation-${randomUUID()}.txt`);
        file.create({ overwrite: true });
        await file.write(document.contents);
        prepared.current = file;
        return file;
      });
      if (Result.isError(written)) {
        setFailed(true);
        return;
      }
      const facts = await readLocalFile(fetch, written.value.uri);
      if (Result.isError(facts)) {
        setFailed(true);
        return;
      }
      // The save sheet picks the matter and uploads; once saved it closes
      // this sheet too.
      router.push({
        pathname: "/scan/save",
        params: {
          mimeType: document.mimeType,
          name: document.name,
          origin: UPLOAD_ORIGIN.dictation,
          sha256Hex: facts.value.sha256Hex,
          size: String(facts.value.size),
          uri: written.value.uri,
        },
      });
    });
  };

  const sendToChat = () => {
    router.replace({
      pathname: "/thread/[threadId]",
      params: {
        dictated: text.trim(),
        fresh: "1",
        threadId: randomUUID(),
        title: chat("newChat"),
      },
    });
  };

  const copy = () => {
    startCopying(async () => {
      const done = await Result.tryPromise(
        async () => await copyText(text.trim()),
      );
      setCopied(done.isOk() && done.value);
    });
  };

  return (
    <ScrollView
      alwaysBounceVertical={false}
      className="bg-background flex-1"
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <Textarea
        accessibilityLabel={t("text")}
        onChangeText={(next) => {
          setText(next);
          setCopied(false);
        }}
        value={text}
      />
      {failed ? <Text variant="caption">{t("saveFailed")}</Text> : null}
      <View className="gap-2">
        <Button disabled={empty || preparing} onPress={saveToMatter}>
          {scan("saveTitle")}
        </Button>
        <Button disabled={empty} onPress={sendToChat} variant="outline">
          {t("sendToChat")}
        </Button>
        <Button disabled={empty || copying} onPress={copy} variant="outline">
          {copied ? t("copied") : t("copy")}
        </Button>
      </View>
    </ScrollView>
  );
};

/**
 * Takes the finished dictation from the native side and transcribes it with
 * the person's choices on this phone. Its recording is deleted once it is
 * transcribed, or heard to be silent. One with a piece not transcribed goes
 * to the composer's kept dictations, retried as the phone comes online and
 * offered for pasting into a conversation once transcribed; when the phone
 * cannot keep it, it stays here for a retry.
 */
const readDictation = async ({
  source,
  locale,
  kept,
}: {
  source: AccessTokenSource;
  locale: string;
  kept: KeptDictations | null;
}): Promise<Reading> => {
  const outcome = await Result.tryPromise(async (): Promise<Reading> => {
    const pieces = await takeQuickDictation();
    if (pieces === null) {
      return { type: "none" };
    }
    const session = source.session();
    // A choice the phone cannot read is no choice: the server's default;
    // fixes it cannot read are not applied.
    const [preferences, learned] =
      session === undefined
        ? [DEFAULT_DICTATION_PREFERENCES, []]
        : await Promise.all([
            readDictationPreferences(deviceAccountStore, session).catch(
              () => DEFAULT_DICTATION_PREFERENCES,
            ),
            readLearnedFixes(deviceAccountStore, session).catch(() => []),
          ]);
    const text = await transcribeQuickDictation({
      fetch,
      learned,
      locale,
      pieces: pieces.map((uri) => new File(uri)),
      preferences,
      source,
    });
    if (text.type !== "failed") {
      await discardQuickDictation();
      return text;
    }
    const isKept =
      !text.signedOut &&
      (kept?.keep({
        owner: randomUUID(),
        setup: {
          field: "chat",
          matterId: null,
          modelId: chosenModelId(preferences) ?? null,
          modelClass: preferences.modelClass,
          locale,
          cleanup: preferences.cleanup,
        },
        pieces: text.pieces.map((piece): FinishedPiece => {
          if (piece.type === "text") {
            return piece;
          }
          const uri = pieces.at(piece.index);
          return uri === undefined
            ? panic("A dictation piece has no recording")
            : { type: "audio", uri };
        }),
        refused: text.refused,
        refusedFor: text.refusedFor,
      }) ??
        false);
    if (!isKept) {
      return { type: "failed", signedOut: text.signedOut };
    }
    // Its recordings are kept elsewhere now.
    await discardQuickDictation();
    return { type: "kept", refused: text.refused, refusedFor: text.refusedFor };
  });
  return Result.isOk(outcome)
    ? outcome.value
    : { type: "failed", signedOut: false };
};

export default DictationScreen;
