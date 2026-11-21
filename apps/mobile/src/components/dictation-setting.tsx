import { Suspense, use, useState, useTransition } from "react";

import type { Result } from "better-result";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import type { DesktopDictationModels } from "@stll/api-contract/desktop-dictation-transcription";
import { Button } from "@stll/ui/button";
import { Switch } from "@stll/ui/switch";
import { Text } from "@stll/ui/text";

import { DictationLearnedSetting } from "@/components/dictation-learned-setting";
import type { AccessTokenSource, StoredSession } from "@/connection/session";
import { CheckIcon } from "@/icons.gen";
import { deviceAccountStore } from "@/native/account-store";
import { DICTATION_ROUTE_AVAILABLE } from "@/native/dictation-device";
import type { ApiError } from "@/state/api-request";
import { readDictationModels } from "@/state/dictation";
import {
  DEFAULT_DICTATION_PREFERENCES,
  readDictationPreferences,
  shownModel,
  writeDictationPreferences,
} from "@/state/dictation-preferences";
import type {
  DictationMicrophone,
  DictationPreferences,
} from "@/state/dictation-preferences";
import { useUiColors } from "@/theme";

/**
 * How this account dictates on this phone: the model, with where it runs and
 * whether its provider keeps the audio said beside it, whether stella AI
 * tidies the text, and whether the iPhone's own microphone records. All are
 * kept on the phone, so the choice shows what was written, not what was
 * tapped.
 */
export const DictationSetting = ({
  session,
  source,
}: {
  session: StoredSession;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("settings");
  const read = async () =>
    await readDictationPreferences(deviceAccountStore, session).catch(
      () => DEFAULT_DICTATION_PREFERENCES,
    );
  const [stored, setStored] = useState(read);
  const [models] = useState(
    async () => await readDictationModels({ fetch, source }),
  );
  const [saving, startSaving] = useTransition();

  const save = (
    change: (current: DictationPreferences) => DictationPreferences,
  ) => {
    startSaving(async () => {
      const current = await stored;
      await writeDictationPreferences(
        deviceAccountStore,
        session,
        change(current),
      ).catch(() => undefined);
      const kept = read();
      await kept;
      setStored(kept);
    });
  };

  return (
    <View className="gap-2">
      <View className="px-1">
        <Text accessibilityRole="header" variant="section">
          {t("dictationTitle")}
        </Text>
      </View>
      <Suspense fallback={null}>
        <DictationChoices
          disabled={saving}
          models={models}
          onCleanup={(cleanup) => {
            save((current) => ({ ...current, cleanup }));
          }}
          onMicrophone={(microphone) => {
            save((current) => ({ ...current, microphone }));
          }}
          onModel={(modelId) => {
            save((current) => ({ ...current, modelId }));
          }}
          stored={stored}
        />
      </Suspense>
      <DictationLearnedSetting session={session} />
    </View>
  );
};

const DictationChoices = ({
  disabled,
  models,
  onCleanup,
  onMicrophone,
  onModel,
  stored,
}: {
  disabled: boolean;
  models: Promise<Result<DesktopDictationModels, ApiError>>;
  onCleanup: (cleanup: boolean) => void;
  onMicrophone: (microphone: DictationMicrophone) => void;
  onModel: (modelId: string | null) => void;
  stored: Promise<DictationPreferences>;
}) => {
  const t = useTranslations("settings");
  const ui = useUiColors();
  const preferences = use(stored);
  const offered = use(models);
  const list = offered.isOk() ? offered.value.models : [];
  // A picked model the server stopped offering counts as the default, as a
  // dictation then uses it. While the list cannot be read, the picked model
  // is still what a dictation sends, so it keeps its row, named by its id.
  const { selected, unlisted } = shownModel(
    preferences,
    offered.isOk() ? list : null,
  );
  // The provider of the picked model keeps what is dictated: said in full,
  // as where it is picked on the computer.
  const retaining = list.find(
    ({ id, retainsData }) => id === selected && retainsData === true,
  );
  const modelNote =
    retaining === undefined
      ? t(offered.isOk() ? "dictationModelHint" : "dictationModelsUnavailable")
      : t("dictationModelRetainsWarning", {
          provider: retaining.provider ?? retaining.displayName,
        });
  const defaultName =
    offered.isOk() && offered.value.defaultModelId !== null
      ? list.find(({ id }) => id === offered.value.defaultModelId)?.displayName
      : undefined;
  const rows = [
    {
      id: null,
      title:
        defaultName === undefined
          ? t("dictationModelDefault")
          : t("dictationModelDefaultNamed", { model: defaultName }),
      notes: [],
    },
    ...list.map((model) => ({
      id: model.id,
      title: model.displayName,
      notes: [
        ...(model.provider === undefined ? [] : [model.provider]),
        ...(model.outsideRegion === true
          ? [t("dictationModelOutsideRegion")]
          : []),
        ...(model.retainsData === true ? [t("dictationModelRetainsData")] : []),
      ],
    })),
    ...(unlisted && selected !== null
      ? [{ id: selected, title: selected, notes: [] }]
      : []),
  ];

  return (
    <>
      <View className="border-border bg-card rounded-xl border px-3">
        {rows.map((row, index) => (
          <Button
            accessibilityRole="radio"
            accessibilityState={{ selected: row.id === selected, disabled }}
            disabled={disabled}
            key={row.id ?? "default"}
            onPress={() => {
              onModel(row.id);
            }}
            size="row"
            variant="ghost"
          >
            <View
              className={`flex-1 flex-row items-center gap-3 ${
                index === rows.length - 1 ? "" : "border-border border-b"
              }`}
            >
              <View className="flex-1 gap-0.5">
                <Text numberOfLines={1} variant="rowTitle">
                  {row.title}
                </Text>
                {row.notes.length === 0 ? null : (
                  <Text variant="caption">{row.notes.join(" · ")}</Text>
                )}
              </View>
              {row.id === selected ? (
                <CheckIcon color={ui.foreground} size={18} />
              ) : null}
            </View>
          </Button>
        ))}
      </View>
      <View className="px-1">
        <Text variant="caption">{modelNote}</Text>
      </View>
      <View className="border-border bg-card flex-row items-center gap-3 rounded-xl border p-4">
        <Text className="flex-1">{t("dictationCleanup")}</Text>
        <Switch
          accessibilityLabel={t("dictationCleanup")}
          checked={preferences.cleanup}
          disabled={disabled}
          onCheckedChange={onCleanup}
        />
      </View>
      <View className="px-1">
        <Text variant="caption">{t("dictationCleanupHint")}</Text>
      </View>
      {DICTATION_ROUTE_AVAILABLE ? (
        <>
          <View className="border-border bg-card flex-row items-center gap-3 rounded-xl border p-4">
            <Text className="flex-1">{t("dictationBuiltInMicrophone")}</Text>
            <Switch
              accessibilityLabel={t("dictationBuiltInMicrophone")}
              checked={preferences.microphone === "built-in"}
              disabled={disabled}
              onCheckedChange={(checked) => {
                onMicrophone(checked ? "built-in" : "system");
              }}
            />
          </View>
          <View className="px-1">
            <Text variant="caption">{t("dictationBuiltInMicrophoneHint")}</Text>
          </View>
        </>
      ) : null}
    </>
  );
};
