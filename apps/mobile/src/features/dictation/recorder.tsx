import { useEffect, useRef, useState, useTransition } from "react";

import { Result } from "better-result";
import { useLocalSearchParams } from "expo-router";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  ScrollView,
  View,
} from "react-native";
import { useTranslations } from "use-intl";

import { screenStyles } from "@/components/empty-state-screen";
import { useSelection } from "@/components/selection";
import { Text } from "@/components/ui/text";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { ActionButton } from "@/features/dictation/action-button";
import { ActiveRecording } from "@/features/dictation/active-recording";
import { DraftList } from "@/features/dictation/draft-list";
import { canApplyRecorderAction } from "@/features/dictation/recorder-state";
import { recordingSignal } from "@/features/dictation/signal";
import { useRecorderStatus } from "@/features/dictation/use-recorder-status";
import type {
  DictationRecorder,
  NativeDraft,
} from "@/native/dictation-recorder";
import { useUiColors } from "@/theme";

export const Recorder = ({
  source,
  recorder,
}: {
  source: AccessTokenSource;
  recorder: DictationRecorder;
}) => {
  const { deleteDraft, finish, listDrafts, resume, start, status } = recorder;
  const t = useTranslations("dictation");
  const chat = useTranslations("chat");
  const { matterId: initialMatterId } = useLocalSearchParams<{
    matterId?: string;
  }>();
  const [drafts, setDrafts] = useState<NativeDraft[]>([]);
  const [active, setActive] = useState<NativeDraft | null>(null);
  const [failure, setFailure] = useState(false);
  const [pending, startAction] = useTransition();
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(epochMilliseconds);
  const busy = useRef(false);
  const revision = useRef(0);
  const ui = useUiColors();
  const { matter } = useSelection();
  const contextMatterId = active?.matterId ?? initialMatterId;
  const contextName =
    matter !== null && matter.workspaceId === contextMatterId
      ? matter.name
      : null;
  const signal = recordingSignal({
    status: active?.status ?? "paused",
    lastMeterAt: active?.lastMeterAt ?? null,
    recordingSince: active?.recordingSince ?? null,
    now,
    db: active?.levels.at(-1)?.db ?? -100,
  });

  useEffect(() => {
    let mounted = true;
    void Result.tryPromise(listDrafts).then((result) => {
      if (!mounted) {
        return undefined;
      }
      if (Result.isError(result)) {
        setFailure(true);
      } else {
        setDrafts(result.value);
      }
      setLoaded(true);
      return undefined;
    });
    return () => {
      mounted = false;
    };
  }, [listDrafts]);

  useRecorderStatus({
    active,
    busy,
    revision,
    status,
    update: setActive,
    fail: setFailure,
    tick: setNow,
  });

  useEffect(() => {
    if (signal === "no-signal") {
      AccessibilityInfo.announceForAccessibility(t("noSignal"));
    }
  }, [signal, t]);

  const run = (operation: () => Promise<NativeDraft | null>) => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    revision.current += 1;
    startAction(async () => {
      setFailure(false);
      const result = await Result.tryPromise(operation);
      if (Result.isError(result)) {
        setFailure(true);
      } else {
        const next = result.value;
        setActive(next);
        setNow(epochMilliseconds());
        const refreshed = await Result.tryPromise(listDrafts);
        if (Result.isOk(refreshed)) {
          setDrafts(refreshed.value);
        } else {
          setFailure(true);
        }
      }
      busy.current = false;
    });
  };

  const remove = (draft: NativeDraft) => {
    if (!canApplyRecorderAction(draft.status, "delete")) {
      return;
    }
    Alert.alert(t("deleteTitle"), t("deleteMessage"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("delete"),
        style: "destructive",
        onPress: () => {
          run(async () => {
            await deleteDraft(draft.id);
            return active?.id === draft.id ? null : active;
          });
        },
      },
    ]);
  };

  return (
    <ScrollView
      className="bg-background flex-1"
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      {failure ? (
        <View className="gap-2">
          <Text variant="error" accessibilityRole="alert">
            {t("failed")}
          </Text>
          <ActionButton
            disabled={pending}
            label={chat("retry")}
            onPress={() => {
              run(async () => active);
            }}
          />
        </View>
      ) : null}
      {!loaded || pending ? (
        <ActivityIndicator color={ui.mutedForeground} />
      ) : null}
      {active === null ? (
        <>
          {initialMatterId === undefined ? null : (
            <Text variant="caption">{contextName ?? t("matterSelected")}</Text>
          )}
          <ActionButton
            disabled={
              !loaded ||
              pending ||
              drafts.some((draft) => draft.status === "recording")
            }
            label={t("record")}
            onPress={() => {
              run(async () => await start(initialMatterId ?? null));
            }}
          />
          <DraftList
            drafts={drafts}
            pending={pending}
            onOpen={(draft) => {
              if (draft.status === "paused") {
                run(async () => await resume(draft.id));
              } else {
                setActive(draft);
              }
            }}
            onFinish={(draft) => {
              run(async () => await finish(draft.id));
            }}
            onDelete={remove}
          />
        </>
      ) : (
        <ActiveRecording
          active={active}
          pending={pending}
          contextName={contextName}
          signal={signal}
          source={source}
          recorder={recorder}
          run={run}
          remove={remove}
          onClose={() => {
            setActive(null);
          }}
        />
      )}
    </ScrollView>
  );
};
