import { useEffect, useEffectEvent } from "react";

import * as Linking from "expo-linking";
import { usePathname, useRouter } from "expo-router";
import { AppState } from "react-native";
import { useTranslations } from "use-intl";

import { useSession } from "@/connection/session-provider";
import {
  clearQuickDictation,
  configureQuickDictation,
  QUICK_DICTATION_AVAILABLE,
  quickDictationPhase,
  watchQuickDictation,
} from "@/native/quick-dictation";
import {
  DICTATION_ROUTE,
  quickDictationConfiguration,
} from "@/state/quick-dictation";
import { DictationActivity } from "@/widgets/dictation-activity";

/**
 * Keeps the native side of a dictation started outside the app
 * (`modules/quick-dictation`) in step with the app: signed in, it holds the
 * Live Activity's words in the app's language; signed out, it holds
 * nothing, so a press opens the sign-in instead, and whatever was recorded
 * is deleted. A finished dictation opens its sheet as soon as the app is in
 * front. Renders nothing; a build without it skips it all.
 */
export const QuickDictationSync = () => {
  const { state } = useSession();
  const t = useTranslations("quickDictation");
  const chat = useTranslations("chat");
  const router = useRouter();
  const pathname = usePathname();
  const signedIn = state.status === "signed-in";
  // Registers the activity's layout, which the native side starts by name.
  const available = QUICK_DICTATION_AVAILABLE && DictationActivity !== null;

  useEffect(() => {
    if (!available) {
      return;
    }
    if (!signedIn) {
      void clearQuickDictation().catch(() => undefined);
      return;
    }
    configureQuickDictation(
      quickDictationConfiguration({
        labels: {
          cancel: chat("dictationCancel"),
          finish: chat("dictationFinish"),
          readyDetail: t("activityReadyDetail"),
          readyTitle: t("activityReady"),
          recordingDetail: t("activityRecordingDetail"),
          recordingTitle: t("activityRecording"),
        },
        link: Linking.createURL(DICTATION_ROUTE),
      }),
    );
  }, [available, chat, signedIn, t]);

  const openWhenFinished = useEffectEvent(async () => {
    if (
      !signedIn ||
      AppState.currentState !== "active" ||
      pathname === `/${DICTATION_ROUTE}`
    ) {
      return;
    }
    if ((await quickDictationPhase()) === "finished") {
      router.push(`/${DICTATION_ROUTE}`);
    }
  });

  useEffect(() => {
    if (!available) {
      return undefined;
    }
    const check = () => {
      void openWhenFinished().catch(() => undefined);
    };
    check();
    const returns = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        check();
      }
    });
    const changes = watchQuickDictation((phase) => {
      if (phase === "finished") {
        check();
      }
    });
    return () => {
      returns.remove();
      changes?.remove();
    };
  }, [available]);

  return null;
};
