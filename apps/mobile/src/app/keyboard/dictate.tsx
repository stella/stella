import { Suspense, use, useState } from "react";

import { panic } from "better-result";
import { requestRecordingPermissionsAsync } from "expo-audio";
import * as Linking from "expo-linking";
import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { Text } from "@stll/ui/text";

import { screenStyles } from "@/components/empty-state-screen";
import { useKeyboardStatus } from "@/components/use-keyboard-status";
import { epochMilliseconds } from "@/connection/clock";
import { useSession } from "@/connection/session-provider";
import {
  cancelKeyboardCapture,
  readKeyboardStatus,
  startKeyboardCapture,
  startKeyboardSession,
  stopKeyboardCapture,
} from "@/native/keyboard-dictation";
import { readKeyboardHandoff } from "@/state/keyboard-dictation";
import type { KeyboardHandoff } from "@/state/keyboard-dictation";

/**
 * Where the stella keyboard opens the app when the microphone is not warm:
 * the app opens it, starts recording the dictation the keyboard named and
 * says how to go back. The person stops the dictation from the keyboard,
 * which inserts its text; this screen can stop or cancel it too.
 */
const KeyboardDictateScreen = () => {
  const t = useTranslations("keyboardDictation");
  const { state } = useSession();
  const params = useLocalSearchParams();
  return (
    <ScrollView
      alwaysBounceVertical={false}
      className="bg-background flex-1"
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={{ title: t("title") }} />
      {state.status === "signed-in" ? (
        <Handoff handoff={readKeyboardHandoff(params, epochMilliseconds())} />
      ) : null}
    </ScrollView>
  );
};

type HandoffStart =
  | { readonly type: "started"; readonly jobId: string | undefined }
  | { readonly type: "denied" }
  | { readonly type: "failed" };

const Handoff = ({ handoff }: { handoff: KeyboardHandoff }) => {
  // Started once, as the screen opens: a later render never records again.
  const [started] = useState(async () => await begin(handoff));
  return (
    <Suspense fallback={<Loader />}>
      <HandoffStatus started={started} />
    </Suspense>
  );
};

/**
 * Opens the microphone, kept warm as Settings says, and records the
 * dictation the link named. A capture that cannot start (one is under way
 * already) leaves the session to say what it is doing.
 */
const begin = async (handoff: KeyboardHandoff): Promise<HandoffStart> => {
  const permission = await requestRecordingPermissionsAsync();
  if (!permission.granted) {
    return { type: "denied" };
  }
  const session = startKeyboardSession(readKeyboardStatus()?.keepWarm ?? 0);
  if (session !== "started") {
    return { type: session };
  }
  return {
    type: "started",
    jobId:
      handoff.type === "record" &&
      startKeyboardCapture(handoff.jobId, handoff.language)
        ? handoff.jobId
        : undefined,
  };
};

const HandoffStatus = ({ started }: { started: Promise<HandoffStart> }) => {
  const t = useTranslations();
  const format = useFormatter();
  const outcome = use(started);
  const { status } = useKeyboardStatus();
  if (outcome.type === "denied") {
    return (
      <View className="gap-3">
        <Text>{t("keyboardDictation.micDenied")}</Text>
        <Button
          onPress={() => {
            void Linking.openSettings();
          }}
          variant="outline"
        >
          {t("keyboardDictation.openSettings")}
        </Button>
      </View>
    );
  }
  if (outcome.type === "failed") {
    return <Text>{t("keyboardDictation.micFailed")}</Text>;
  }
  const session = status?.session ?? { type: "off" };
  if (session.type === "off") {
    return <Text>{t("keyboardDictation.micOff")}</Text>;
  }
  switch (session.phase) {
    case "recording":
      return (
        <View className="gap-3">
          <Text>{t("keyboardDictation.recordingHere")}</Text>
          {session.jobId === undefined ? null : (
            <CaptureButtons jobId={session.jobId} />
          )}
        </View>
      );
    case "transcribing":
      return <Text>{t("keyboard.transcribing")}</Text>;
    case "ready":
      return (
        <Text>
          {t("keyboardDictation.warmReady", {
            time: format.dateTime(new Date(session.warmUntil), {
              timeStyle: "short",
            }),
          })}
        </Text>
      );
    default:
      session.phase satisfies never;
      return panic(`No status for the phase ${String(session.phase)}`);
  }
};

const CaptureButtons = ({ jobId }: { jobId: string }) => {
  const t = useTranslations("keyboard");
  return (
    <View className="flex-row gap-3">
      <Button
        className="flex-1"
        onPress={() => {
          stopKeyboardCapture(jobId);
        }}
      >
        {t("stop")}
      </Button>
      <Button
        className="flex-1"
        onPress={() => {
          cancelKeyboardCapture(jobId);
        }}
        variant="outline"
      >
        {t("cancel")}
      </Button>
    </View>
  );
};

export default KeyboardDictateScreen;
