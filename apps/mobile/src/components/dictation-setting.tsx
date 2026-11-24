import { Suspense, use, useState, useTransition } from "react";

import type { Result } from "better-result";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import {
  DESKTOP_DICTATION_CLEANUP_STYLES,
  DESKTOP_DICTATION_TRANSLATION_LANGUAGES,
} from "@stll/api-contract/desktop-dictation-cleanup";
import type {
  DesktopDictationCleanupStyle,
  DesktopDictationTranslationLanguage,
} from "@stll/api-contract/desktop-dictation-cleanup";
import type { DesktopDictationModels } from "@stll/api-contract/desktop-dictation-transcription";
import { displayLanguageName } from "@stll/locales";
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
import { classOf } from "@/state/dictation-fallback";
import type { ModelClass } from "@/state/dictation-fallback";
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
 * tidies the text (and while it does, in which style and language), and
 * whether the iPhone's own microphone records. All are kept on the phone,
 * so the choice shows what was written, not what was tapped.
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
          onModel={(modelId, modelClass) => {
            save((current) => ({ ...current, modelId, modelClass }));
          }}
          onStyle={(style) => {
            save((current) => ({ ...current, style }));
          }}
          onTranslateTo={(translateTo) => {
            save((current) => ({ ...current, translateTo }));
          }}
          stored={stored}
        />
      </Suspense>
      <DictationLearnedSetting session={session} source={source} />
    </View>
  );
};

const STYLE_KEYS = {
  polished: {
    title: "dictationStylePolished",
    hint: "dictationStylePolishedHint",
  },
  casual: { title: "dictationStyleCasual", hint: "dictationStyleCasualHint" },
  notes: { title: "dictationStyleNotes", hint: "dictationStyleNotesHint" },
  verbatim: {
    title: "dictationStyleVerbatim",
    hint: "dictationStyleVerbatimHint",
  },
} as const satisfies Record<
  DesktopDictationCleanupStyle,
  { title: string; hint: string }
>;

type ChoiceRow<T> = {
  readonly id: T;
  readonly title: string;
  readonly notes: readonly string[];
};

/** A card of rows of which one is picked, the way the model is picked. */
const ChoiceRows = <T extends string | null>({
  disabled,
  onPick,
  rows,
  selected,
}: {
  disabled: boolean;
  onPick: (id: T) => void;
  rows: readonly ChoiceRow<T>[];
  selected: T;
}) => {
  const ui = useUiColors();
  return (
    <View className="border-border bg-card rounded-xl border px-3">
      {rows.map((row, index) => (
        <Button
          accessibilityRole="radio"
          accessibilityState={{ selected: row.id === selected, disabled }}
          disabled={disabled}
          key={row.id ?? "none"}
          onPress={() => {
            onPick(row.id);
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
  );
};

const DictationChoices = ({
  disabled,
  models,
  onCleanup,
  onMicrophone,
  onModel,
  onStyle,
  onTranslateTo,
  stored,
}: {
  disabled: boolean;
  models: Promise<Result<DesktopDictationModels, ApiError>>;
  onCleanup: (cleanup: boolean) => void;
  onMicrophone: (microphone: DictationMicrophone) => void;
  onModel: (modelId: string | null, modelClass: ModelClass | null) => void;
  onStyle: (style: DesktopDictationCleanupStyle) => void;
  onTranslateTo: (
    translateTo: DesktopDictationTranslationLanguage | null,
  ) => void;
  stored: Promise<DictationPreferences>;
}) => {
  const t = useTranslations("settings");
  const ui = useUiColors();
  const preferences = use(stored);
  const offered = use(models);
  const list = offered.isOk() ? offered.value.models : [];
  // A picked model with no row, the list unreadable or the model withdrawn,
  // is still what a dictation names, so it keeps a row of its own, named by
  // its id; a withdrawn one says so until another is picked.
  const { selected, standing } = shownModel(
    preferences,
    offered.isOk() ? list : null,
  );
  // The provider of the picked model keeps what is dictated: said in full,
  // as where it is picked on the computer.
  const retaining = list.find(
    ({ id, retainsData }) => id === selected && retainsData === true,
  );
  let modelNote = t(
    offered.isOk() ? "dictationModelHint" : "dictationModelsUnavailable",
  );
  if (standing === "withdrawn") {
    modelNote = t("dictationModelWithdrawnHint");
  } else if (retaining !== undefined) {
    modelNote = t("dictationModelRetainsWarning", {
      provider: retaining.provider ?? retaining.displayName,
    });
  }
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
      modelClass: null,
    },
    ...list.map((model) => ({
      id: model.id,
      title: model.displayName,
      modelClass: classOf(model),
      notes: [
        ...(model.provider === undefined ? [] : [model.provider]),
        ...(model.outsideRegion === true
          ? [t("dictationModelOutsideRegion")]
          : []),
        ...(model.retainsData === true ? [t("dictationModelRetainsData")] : []),
      ],
    })),
    ...(standing !== "listed" && selected !== null
      ? [
          {
            id: selected,
            title: selected,
            notes:
              standing === "withdrawn" ? [t("dictationModelWithdrawn")] : [],
            modelClass: preferences.modelClass,
          },
        ]
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
              onModel(row.id, row.modelClass);
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
      {preferences.cleanup ? (
        <>
          <View className="px-1 pt-2">
            <Text variant="rowTitle">{t("dictationStyle")}</Text>
          </View>
          <ChoiceRows
            disabled={disabled}
            onPick={onStyle}
            rows={DESKTOP_DICTATION_CLEANUP_STYLES.map((style) => ({
              id: style,
              title: t(STYLE_KEYS[style].title),
              notes: [t(STYLE_KEYS[style].hint)],
            }))}
            selected={preferences.style}
          />
          <View className="px-1 pt-2">
            <Text variant="rowTitle">{t("dictationTranslate")}</Text>
          </View>
          <ChoiceRows
            disabled={disabled}
            onPick={onTranslateTo}
            rows={[
              { id: null, title: t("dictationTranslateOff"), notes: [] },
              // Each language by its own name, as language pickers show
              // them, so the speaker finds theirs whatever the app's language.
              ...DESKTOP_DICTATION_TRANSLATION_LANGUAGES.map((language) => ({
                id: language,
                title: displayLanguageName(language),
                notes: [],
              })),
            ]}
            selected={preferences.translateTo}
          />
          <View className="px-1">
            <Text variant="caption">{t("dictationTranslateHint")}</Text>
          </View>
        </>
      ) : null}
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
