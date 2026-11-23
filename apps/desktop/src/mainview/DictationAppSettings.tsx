import { useState } from "react";

import { useTranslations } from "use-intl";

import { displayLanguageName } from "@stll/locales";
import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import {
  SettingsRow,
  settingsRowIds,
  SettingsSection,
} from "@stll/ui/settings";

const APP_KINDS = [
  "email",
  "chat",
  "document",
  "browser",
  "code",
  "terminal",
  "other",
] as const;

export type DictationAppKind = (typeof APP_KINDS)[number];

export type DictationAppTarget =
  | { identifier: string; name: string; type: "app" }
  | { kind: DictationAppKind; type: "kind" };

/** An app or kind of app with its own settings; `null` follows the kind's
 *  entry, then the global setting. */
export type DictationAppSetting = {
  cleanup: "on" | "off" | null;
  /** `auto` or a language the speech model lists. */
  language: string | null;
  target: DictationAppTarget;
};

/** An app dictated into since stella started. */
export type DictationRecentApp = {
  identifier: string;
  kind: DictationAppKind;
  name: string;
};

const DEFAULT = "default";
const AUTOMATIC_LANGUAGE = "auto";
const ROW_ID = "dictation-app-settings";

const targetKey = (target: DictationAppTarget): string =>
  target.type === "app" ? `app:${target.identifier}` : `kind:${target.kind}`;

/**
 * Settings → Dictation → Per app: AI cleanup and the language for one app
 * or one kind of app, over the settings above. `onChange` resolves to
 * whether the native side stored the new list.
 */
export const DictationAppSettings = ({
  languages,
  onChange,
  recentApps,
  settings,
}: {
  /** The languages the speech model lists. */
  languages: readonly string[];
  onChange: (settings: DictationAppSetting[]) => Promise<boolean>;
  recentApps: readonly DictationRecentApp[];
  settings: readonly DictationAppSetting[];
}) => {
  const t = useTranslations("dictation.perApp");
  const [failed, setFailed] = useState(false);
  const ids = settingsRowIds(ROW_ID);

  const save = async (next: DictationAppSetting[]) => {
    setFailed(!(await onChange(next)));
  };

  const listed = new Set(settings.map((setting) => targetKey(setting.target)));
  const addable: DictationAppTarget[] = [
    ...recentApps.map(({ identifier, name }): DictationAppTarget => ({
      identifier,
      name,
      type: "app",
    })),
    ...APP_KINDS.map((kind): DictationAppTarget => ({ kind, type: "kind" })),
  ].filter((target) => !listed.has(targetKey(target)));
  const kindLabel = (kind: DictationAppKind) => t(`kinds.${kind}`);
  const targetLabel = (target: DictationAppTarget) =>
    target.type === "app" ? target.name : kindLabel(target.kind);

  const replace = (index: number, next: DictationAppSetting) =>
    settings.map((setting, at) => (at === index ? next : setting));

  return (
    <SettingsSection title={t("group")}>
      <SettingsRow
        description={t("description")}
        footer={
          failed ? (
            <p className="text-destructive-foreground text-xs" role="alert">
              {t("failed")}
            </p>
          ) : null
        }
        id={ROW_ID}
        title={t("title")}
      >
        {addable.length > 0 && (
          <Select<string | null>
            onValueChange={(value) => {
              const target = addable.find(
                (candidate) => targetKey(candidate) === value,
              );
              if (target !== undefined) {
                void save([
                  ...settings,
                  { cleanup: null, language: null, target },
                ]);
              }
            }}
            value={null}
          >
            <SelectTrigger aria-labelledby={ids.label} className="w-44">
              <SelectValue placeholder={t("add")} />
            </SelectTrigger>
            <SelectPopup>
              <AddGroup
                label={t("recentApps")}
                targets={addable.filter((target) => target.type === "app")}
                targetLabel={targetLabel}
              />
              <AddGroup
                label={t("kindsOfApp")}
                targets={addable.filter((target) => target.type === "kind")}
                targetLabel={targetLabel}
              />
            </SelectPopup>
          </Select>
        )}
      </SettingsRow>
      {settings.map((setting, index) => (
        <DictationAppSettingRow
          key={targetKey(setting.target)}
          languages={languages}
          name={targetLabel(setting.target)}
          onChange={(next) => {
            void save(replace(index, next));
          }}
          onRemove={() => {
            void save(settings.filter((_, at) => at !== index));
          }}
          setting={setting}
        />
      ))}
    </SettingsSection>
  );
};

const AddGroup = ({
  label,
  targetLabel,
  targets,
}: {
  label: string;
  targetLabel: (target: DictationAppTarget) => string;
  targets: readonly DictationAppTarget[];
}) =>
  targets.length === 0 ? null : (
    <SelectGroup>
      <SelectGroupLabel>{label}</SelectGroupLabel>
      {targets.map((target) => (
        <SelectItem key={targetKey(target)} value={targetKey(target)}>
          {targetLabel(target)}
        </SelectItem>
      ))}
    </SelectGroup>
  );

/** One app or kind of app: its cleanup and language, and removing it. */
const DictationAppSettingRow = ({
  languages,
  name,
  onChange,
  onRemove,
  setting,
}: {
  languages: readonly string[];
  name: string;
  onChange: (setting: DictationAppSetting) => void;
  onRemove: () => void;
  setting: DictationAppSetting;
}) => {
  const t = useTranslations("dictation.perApp");
  const tLanguage = useTranslations("dictation.language");
  const cleanupLabels = {
    [DEFAULT]: t("cleanup.default"),
    off: t("cleanup.off"),
    on: t("cleanup.on"),
  } as const;
  const languageLabel = (value: string) => {
    if (value === DEFAULT) {
      return t("language.default");
    }
    return value === AUTOMATIC_LANGUAGE
      ? tLanguage("automatic")
      : displayLanguageName(value);
  };
  const languageItems = [DEFAULT, AUTOMATIC_LANGUAGE, ...languages];

  return (
    <SettingsRow
      depth="nested"
      id={`dictation-app-${targetKey(setting.target)}`}
      title={name}
    >
      <div className="flex items-center gap-2">
        <Select<string>
          onValueChange={(value) => {
            onChange({
              ...setting,
              cleanup: value === "on" || value === "off" ? value : null,
            });
          }}
          value={setting.cleanup ?? DEFAULT}
        >
          <SelectTrigger
            aria-label={t("cleanup.label", { name })}
            className="w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {([DEFAULT, "on", "off"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {cleanupLabels[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select<string>
          onValueChange={(value) => {
            onChange({
              ...setting,
              language: value === DEFAULT ? null : value,
            });
          }}
          value={
            setting.language !== null &&
            languageItems.includes(setting.language)
              ? setting.language
              : DEFAULT
          }
        >
          <SelectTrigger
            aria-label={t("language.label", { name })}
            className="w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {languageItems.map((value) => (
              <SelectItem key={value} value={value}>
                {languageLabel(value)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          aria-label={t("remove", { name })}
          onClick={onRemove}
          size="icon"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
    </SettingsRow>
  );
};
