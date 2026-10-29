import { useEffect, useState } from "react";

import { Result } from "better-result";
import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useTranslations } from "use-intl";

import { Text } from "@/components/ui/text";
import { useSession } from "@/connection/session-provider";
import type { DictationRecorder } from "@/native/dictation-recorder";

/** A saved recording is offered once after sign-in, without changing its files. */
export const DraftRecovery = ({
  recorder,
}: {
  recorder: DictationRecorder | null;
}) => {
  const { state } = useSession();
  const router = useRouter();
  const t = useTranslations("dictation");
  const [loaded, setLoaded] = useState<{
    recorder: DictationRecorder;
    status: "draft" | "failed";
  } | null>(null);
  const notice = loaded?.recorder === recorder ? loaded.status : "hidden";
  const signedIn = state.status === "signed-in";

  useEffect(() => {
    if (!signedIn || recorder === null) {
      return;
    }
    let mounted = true;
    void Result.tryPromise(recorder.listDrafts).then((result) => {
      if (!mounted) {
        return undefined;
      }
      if (Result.isError(result)) {
        setLoaded({ recorder, status: "failed" });
      } else if (result.value.some((draft) => draft.status !== "finished")) {
        setLoaded({ recorder, status: "draft" });
      }
      return undefined;
    });
    return () => {
      mounted = false;
    };
  }, [signedIn, recorder]);

  if (!signedIn || notice === "hidden") {
    return null;
  }
  return (
    <View className="bg-card flex-row items-center gap-3 px-4 py-2">
      <Pressable
        className="min-h-11 flex-1 justify-center active:opacity-60"
        accessibilityRole="button"
        onPress={() => {
          setLoaded(null);
          router.push("/dictation");
        }}
      >
        <Text variant={notice === "failed" ? "error" : "caption"}>
          {notice === "failed" ? t("recoveryFailed") : t("recover")}
        </Text>
      </Pressable>
      <Pressable
        className="min-h-11 min-w-11 items-center justify-center active:opacity-60"
        accessibilityLabel={t("dismiss")}
        accessibilityRole="button"
        onPress={() => {
          setLoaded(null);
        }}
      >
        <Text variant="caption">{t("dismiss")}</Text>
      </Pressable>
    </View>
  );
};
