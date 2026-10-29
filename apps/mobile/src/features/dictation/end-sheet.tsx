import { Suspense, useEffect, useRef, useState, useTransition } from "react";

import { Result } from "better-result";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  Switch,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFormatter, useTranslations } from "use-intl";

import { useChanged } from "@/components/changes";
import { screenStyles } from "@/components/empty-state-screen";
import { MatterPicker } from "@/components/matter-picker";
import { Text, TextInput } from "@/components/ui/text";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { ActionButton } from "@/features/dictation/action-button";
import {
  exportDictation,
  saveDictationToMatter,
} from "@/features/dictation/actions";
import { loadChoice, rememberChoice } from "@/features/dictation/choices";
import type { DictationAction } from "@/features/dictation/preferences";
import type {
  DictationRecorder,
  NativeDraft,
} from "@/native/dictation-recorder";
import { listMatters } from "@/state/matters";
import { useUiColors } from "@/theme";

export const EndSheet = ({
  draft,
  source,
  recorder,
  onClose,
}: {
  draft: NativeDraft;
  source: AccessTokenSource;
  recorder: DictationRecorder;
  onClose: () => void;
}) => {
  const { exportAudio, shareAudio } = recorder;
  const t = useTranslations("dictation");
  const scan = useTranslations("scan");
  const format = useFormatter();
  const chat = useTranslations("chat");
  const changed = useChanged();
  const { end } = useSession();
  const ui = useUiColors();
  const [action, setAction] = useState<DictationAction>("export");
  const [cleaned, setCleaned] = useState(false);
  const [choiceLoadedFor, setChoiceLoadedFor] =
    useState<DictationAction | null>(null);
  const [matterId, setMatterId] = useState(draft.matterId);
  const [name, setName] = useState(t("defaultName"));
  const [failure, setFailure] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [cleaningResult, setCleaningResult] = useState<{
    attempt: number;
    status: "ready" | "failed";
  } | null>(null);
  const [lastProgress, setLastProgress] = useState({ attempt: 0, value: 0 });
  const [cleaningAttempt, setCleaningAttempt] = useState(0);
  const cleaning =
    cleaningResult?.attempt === cleaningAttempt
      ? cleaningResult.status
      : "preparing";
  const cleaningProgress =
    lastProgress.attempt === cleaningAttempt ? lastProgress.value : 0;
  const [pending, startAction] = useTransition();
  const busy = useRef(false);
  const [matters] = useState(async () => await listMatters({ fetch, source }));

  useEffect(() => {
    let mounted = true;
    let reading = false;
    const timer = setInterval(() => {
      if (reading) {
        return;
      }
      reading = true;
      void Result.tryPromise(async () => await recorder.status(draft.id)).then(
        (result) => {
          reading = false;
          if (
            mounted &&
            Result.isOk(result) &&
            result.value.cleaningProgress !== null
          ) {
            setLastProgress({
              attempt: cleaningAttempt,
              value: result.value.cleaningProgress,
            });
          }
          return undefined;
        },
      );
    }, 250);
    void Result.tryPromise(async () => await exportAudio(draft.id, true)).then(
      (result) => {
        clearInterval(timer);
        if (mounted) {
          setCleaningResult({
            attempt: cleaningAttempt,
            status: Result.isOk(result) ? "ready" : "failed",
          });
        }
        return undefined;
      },
    );
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [draft.id, exportAudio, cleaningAttempt, recorder]);

  useEffect(() => {
    let mounted = true;
    void loadChoice(action).then((result) => {
      if (!mounted) {
        return undefined;
      }
      if (Result.isOk(result)) {
        setCleaned(result.value.cleaned);
      } else {
        setCleaned(false);
        setFailure(true);
      }
      setChoiceLoadedFor(action);
      return undefined;
    });
    return () => {
      mounted = false;
    };
  }, [action]);

  const actionReady =
    choiceLoadedFor === action &&
    (!cleaned || cleaning === "ready") &&
    (action === "export" || (matterId !== null && name.trim() !== ""));
  const complete = () => {
    if (busy.current || !actionReady) {
      return;
    }
    busy.current = true;
    startAction(async () => {
      setFailure(false);
      const choice = await rememberChoice(action, {
        content: "audio",
        cleaned,
      });
      if (Result.isError(choice)) {
        setFailure(true);
        busy.current = false;
        return;
      }
      if (action === "export") {
        const result = await exportDictation({
          draftId: draft.id,
          cleaned,
          exportAudio,
          shareAudio,
        });
        if (Result.isError(result)) {
          setFailure(true);
        } else if (result.value) {
          setCompleted(true);
        }
      } else if (matterId !== null) {
        const result = await saveDictationToMatter({
          fetch,
          source,
          draftId: draft.id,
          cleaned,
          matterId,
          name,
          exportAudio,
        });
        if (Result.isOk(result)) {
          changed("documents");
          setCompleted(true);
        } else if (result.error._tag === "SignedOutError") {
          end(source);
        } else {
          setFailure(true);
        }
      }
      busy.current = false;
    });
  };

  return (
    <Modal
      visible={draft.status === "finished"}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView edges={["top", "bottom"]} className="bg-background flex-1">
        <ScrollView
          className="bg-background flex-1"
          contentContainerStyle={screenStyles.content}
          contentInsetAdjustmentBehavior="automatic"
        >
          <Text variant="title">{t("finished")}</Text>
          {completed ? (
            <Text accessibilityRole="alert">{t("completed")}</Text>
          ) : null}
          {failure ? (
            <Text variant="error" accessibilityRole="alert">
              {t("actionFailed")}
            </Text>
          ) : null}
          <View className="flex-row gap-3">
            <ActionButton
              disabled={pending}
              selected={action === "export"}
              label={t("export")}
              onPress={() => {
                setAction("export");
                setCompleted(false);
              }}
            />
            <ActionButton
              disabled={pending}
              selected={action === "save-to-matter"}
              label={t("saveToMatter")}
              onPress={() => {
                setAction("save-to-matter");
                setCompleted(false);
              }}
            />
          </View>
          <Text variant="section">{t("audio")}</Text>
          <View className="flex-row items-center justify-between gap-3">
            <Text>{t("cleaned")}</Text>
            <Switch
              accessibilityLabel={t("cleaned")}
              disabled={pending || choiceLoadedFor !== action}
              value={cleaned}
              onValueChange={setCleaned}
            />
          </View>
          {cleaning === "preparing" ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator color={ui.mutedForeground} />
              <Text variant="caption">{t("preparing")}</Text>
              <Text
                accessibilityRole="progressbar"
                accessibilityLabel={t("preparing")}
                accessibilityValue={{
                  min: 0,
                  max: 100,
                  now: Math.round(cleaningProgress * 100),
                }}
                variant="caption"
              >
                {format.number(cleaningProgress, {
                  style: "percent",
                  maximumFractionDigits: 0,
                })}
              </Text>
            </View>
          ) : null}
          {cleaning === "failed" ? (
            <View className="gap-2">
              <Text variant="error">{t("cleaningFailed")}</Text>
              <ActionButton
                disabled={pending}
                label={chat("retry")}
                onPress={() => {
                  setCleaningAttempt((attempt) => attempt + 1);
                }}
              />
            </View>
          ) : null}
          {action === "save-to-matter" ? (
            <>
              <TextInput
                accessibilityLabel={scan("name")}
                value={name}
                onChangeText={setName}
              />
              <Text variant="section">{scan("matterTitle")}</Text>
              <Suspense
                fallback={<ActivityIndicator color={ui.mutedForeground} />}
              >
                <MatterPicker
                  matters={matters}
                  selected={matterId}
                  onSelect={setMatterId}
                />
              </Suspense>
            </>
          ) : null}
          {pending ? <ActivityIndicator color={ui.mutedForeground} /> : null}
          <ActionButton
            disabled={pending || !actionReady}
            label={action === "export" ? t("export") : t("saveToMatter")}
            onPress={complete}
          />
          <ActionButton
            disabled={pending}
            label={t("keepDraft")}
            onPress={onClose}
          />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};
