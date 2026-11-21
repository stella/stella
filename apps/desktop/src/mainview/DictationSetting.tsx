import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useLocale, useTranslations } from "use-intl";

import { DESKTOP_DICTATION_CLEANUP_LIMITS } from "@stll/api-contract/desktop-dictation-cleanup";
import { displayLanguageName } from "@stll/locales";
import { Button } from "@stll/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import { Kbd } from "@stll/ui/kbd";
import {
  Select,
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
import { Switch } from "@stll/ui/switch";
import { Tooltip, TooltipFactTrigger, TooltipPopup } from "@stll/ui/tooltip";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import { formatHoldKey, isHoldKey } from "../shared/hold-key";
import type { HoldKey } from "../shared/hold-key";
import { formatShortcut } from "../shared/shortcut-keys";
import type { KeyboardLayout, ShortcutKeys } from "../shared/shortcut-keys";
import {
  DESKTOP_PLATFORM,
  useKeyboardLayout,
} from "../shared/use-clipboard-shortcut";
import { DictationCustomWords } from "./DictationCustomWords";
import { DictationDestination } from "./DictationDestination";
import type { DictationDestinationValue } from "./DictationDestination";
import { DictationInputFix } from "./DictationInputFix";
import { DictationMicrophoneRow } from "./DictationMicrophone";
import { SettingsPageHeader } from "./settings-layout";

type DictationModel =
  | { status: "missing" | "failed" | "ready" }
  | { received: number; status: "downloading"; total: number };

const AUTOMATIC_LANGUAGE = "auto";

type DictationLanguage = {
  /** `auto` or one of `supported`. */
  choice: string;
  /** What automatic means on this computer right now. */
  inferred: string[];
  supported: string[];
};

export type DictationSnapshot = {
  available: boolean;
  /** Whether the transcribed text goes through stella to the organization's
   *  AI provider before it is typed. */
  cleanup: boolean;
  /** Whether the server enables transcription by stella AI; without it the
   *  choice of destination is not offered. */
  cloudAvailable: boolean;
  /** The stella AI model the user picked; null: the region's default. */
  cloudModel: string | null;
  /** The speaker's custom words, kept on this computer for the dictation
   *  account. */
  customWords: string[];
  /** Where speech is transcribed: always this computer while stella AI is
   *  not available. */
  destination: DictationDestinationValue;
  enabled: boolean;
  /** Whether each dictation's text also goes to clipboard history; not
   *  while the user paused it or the organization turned it off. */
  keepsInHistory: boolean;
  language: DictationLanguage;
  /** Whether cleanup also gets the focused window's title. */
  shareWindowTitle: boolean;
  /** Whether a short sound marks the start and the end of listening. */
  sounds: boolean;
  /** Whether cleanup also gets the text before the cursor. */
  shareTextBeforeCursor: boolean;
  /** Whether this computer can read the text before the cursor; without it
   *  the switch is not offered. */
  textBeforeCursorAvailable: boolean;
  failure:
    | "accessibility"
    | "cloudTranscription"
    | "focusChanged"
    | "focusUnconfirmed"
    | "microphone"
    | "modelMissing"
    | "nothingHeard"
    | "passwordField"
    | "shortcutHeld"
    | "transcription"
    | null;
  /** Whether the failed dictation's text is in clipboard history. */
  failureKeptInHistory: boolean;
  /** The key dictation listens for, and what this computer offers. */
  holdKey: HoldKey;
  holdKeys: HoldKey[];
  /** The hold key cannot be heard yet: on a Mac, until stella has
   *  Accessibility access. */
  holdKeyWaiting: boolean;
  /** Control, Option (Alt) and Space: the `combination` choice. */
  keys: ShortcutKeys;
  model: DictationModel;
  modelBytes: number;
  phase: "idle" | "recording" | "transcribing";
  /** Whether a shortcut types the last dictation again, its keys, and
   *  whether another app holds them. */
  retypeKeys: ShortcutKeys;
  retypeShortcut: boolean;
  retypeShortcutTaken: boolean;
  shortcutTaken: boolean;
};

const BYTES_PER_MEGABYTE = 1_000_000;
const PERCENT = 100;

/** The language choice changes something only when cleanup reads it, stella
 *  AI transcribes with it, or the installed speech model takes a language
 *  hint; otherwise it is hidden. */
const languageHasEffect = (snapshot: DictationSnapshot): boolean =>
  snapshot.cleanup ||
  snapshot.destination === "cloud" ||
  (snapshot.model.status === "ready" && snapshot.language.supported.length > 0);

/** Orders the snapshots the native side answers with. Each read or change
 *  takes a ticket as it starts; an answer is shown only when no answer to a
 *  later one is shown already, so a read that started before a change can
 *  never bring back what the change replaced. */
type SnapshotOrder = { shown: number; started: number };

const takeTicket = (order: SnapshotOrder): number => {
  order.started += 1;
  return order.started;
};

/** Whether the answer to `ticket` is the latest; if so, it is now shown. */
const isLatest = (order: SnapshotOrder, ticket: number): boolean => {
  if (ticket <= order.shown) {
    return false;
  }
  order.shown = ticket;
  return true;
};

const isDictationSnapshot = (value: unknown): value is DictationSnapshot =>
  typeof value === "object" &&
  value !== null &&
  "available" in value &&
  typeof value.available === "boolean";

type DictationAvailability = "loading" | "available" | "unavailable";

/**
 * Whether this build and account offer dictation, which decides the
 * Dictation page. Reads the snapshot again on every dictation change, which
 * the native side also sends when the server's decision changes.
 */
export const useDictationAvailability = () => {
  const [availability, setAvailability] =
    useState<DictationAvailability>("loading");

  useEffect(() => {
    let disposed = false;
    let request = 0;
    const read = async () => {
      request += 1;
      const current = request;
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_get_snapshot"),
      );
      if (disposed || current !== request) {
        return;
      }
      setAvailability(
        Result.isOk(result) &&
          isDictationSnapshot(result.value) &&
          result.value.available
          ? "available"
          : "unavailable",
      );
    };
    const stopListening = subscribeDesktopEvent({
      event: "dictation-changed",
      handler: () => {
        void read();
      },
      onError: () => {
        setAvailability("unavailable");
      },
    });
    void read();
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  return availability;
};

/** The Dictation page: the switch, where speech is transcribed, AI cleanup,
 *  the speech model and what went wrong. Renders nothing for an account
 *  without the feature. */
export const DictationSetting = ({
  focus = null,
  onFocusShown = ignoreFocusShown,
}: Partial<DictationFocus>) => {
  // Reading again after a failure starts the page afresh.
  const [attempt, setAttempt] = useState(0);
  return (
    <DictationPage
      focus={focus}
      key={attempt}
      onFocusShown={onFocusShown}
      onRetry={() => {
        setAttempt((current) => current + 1);
      }}
    />
  );
};

const ignoreFocusShown = () => undefined;

type DictationFocus = {
  /** Where a link that opened the page points: the microphone choice. */
  focus: "microphone" | null;
  onFocusShown: () => void;
};

const DictationPage = ({
  focus,
  onFocusShown,
  onRetry,
}: DictationFocus & { onRetry: () => void }) => {
  const t = useTranslations("dictation");
  const tDestination = useTranslations("dictation.destination");
  const locale = useLocale();
  const layout = useKeyboardLayout();
  const [snapshot, setSnapshot] = useState<DictationSnapshot | null>(null);
  // A failed read says so and offers another, rather than leaving the page
  // empty until the next change event.
  const [read, setRead] = useState<"pending" | "failed" | "done">("pending");
  const [removeFailed, setRemoveFailed] = useState(false);
  const order = useRef<SnapshotOrder>({ shown: 0, started: 0 });

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const ticket = takeTicket(order.current);
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_get_snapshot"),
      );
      if (disposed || !isLatest(order.current, ticket)) {
        return;
      }
      const next =
        Result.isOk(result) && isDictationSnapshot(result.value)
          ? result.value
          : null;
      setSnapshot(next);
      setRead(next === null ? "failed" : "done");
    };
    const stopListening = subscribeDesktopEvent({
      event: "dictation-changed",
      handler: () => {
        void refresh();
      },
      onError: () => {
        setSnapshot(null);
        setRead("failed");
      },
    });
    void refresh();
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  if (read === "failed") {
    return <DictationReadFailed onRetry={onRetry} />;
  }

  if (snapshot === null || !snapshot.available) {
    return null;
  }

  const holdKeyLabel = (holdKey: HoldKey) =>
    formatHoldKey({
      holdKey,
      keys: snapshot.keys,
      layout,
      locale,
      platform: DESKTOP_PLATFORM,
      right: (key) => t("holdKey.right", { key }),
    });
  const shortcut = holdKeyLabel(snapshot.holdKey);

  /** Asks the native side for a change and shows the snapshot it answers
   *  with, unless an answer to a later read or change is already shown.
   *  Resolves to whether the native side made the change. */
  const change = async (
    command: string,
    args?: InvokeArgs,
  ): Promise<boolean> => {
    const ticket = takeTicket(order.current);
    const result = await Result.tryPromise(async () =>
      invoke<DictationSnapshot>(command, args),
    );
    if (Result.isOk(result) && isLatest(order.current, ticket)) {
      setSnapshot(result.value);
    }
    return Result.isOk(result);
  };

  const setEnabled = async (enabled: boolean) => {
    await change("dictation_set_enabled", { enabled });
  };

  const setCleanup = async (cleanup: boolean) => {
    await change("dictation_set_cleanup", { enabled: cleanup });
  };

  const setShare = async (
    command:
      | "dictation_set_share_text_before_cursor"
      | "dictation_set_share_window_title",
    enabled: boolean,
  ) => {
    await change(command, { enabled });
  };

  const setLanguage = async (language: string) => {
    await change("dictation_set_language", { language });
  };

  const setDestination = async (destination: DictationDestinationValue) => {
    await change("dictation_set_destination", { destination });
  };

  const setCloudModel = async (modelId: string) => {
    await change("dictation_set_cloud_model", { modelId });
  };

  const setCustomWords = async (words: string[]) =>
    await change("dictation_set_custom_words", { words });

  const download = async () => {
    await change("dictation_download_model");
  };

  const removeModel = async () => {
    const removed = await change("dictation_remove_model");
    setRemoveFailed(!removed);
  };

  const cleanupIds = settingsRowIds("dictation-cleanup");

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        action={
          <Switch
            aria-describedby="dictation-description"
            aria-label={t("title")}
            checked={snapshot.enabled}
            onCheckedChange={(enabled) => {
              void setEnabled(enabled);
            }}
          />
        }
        description={
          <span id="dictation-description">
            {t.rich("lede", {
              key: (chunks) => <Kbd className="mx-0.5">{chunks}</Kbd>,
              shortcut,
            })}
          </span>
        }
        title={t("title")}
      />
      {snapshot.shortcutTaken && (
        <p className="text-destructive-foreground text-sm">
          {t("shortcutTaken", { shortcut })}
        </p>
      )}
      {snapshot.enabled && snapshot.holdKeyWaiting && (
        <p className="text-destructive-foreground text-sm" role="status">
          {DESKTOP_PLATFORM === "mac"
            ? t("holdKey.waiting", { shortcut })
            : t("holdKey.unavailable", { shortcut })}
        </p>
      )}
      {snapshot.failure !== null && (
        <p className="text-destructive-foreground text-sm" role="status">
          {t(`failure.${snapshot.failure}`)}
          {/* Two sentences, each translated whole. */}
          {snapshot.failureKeptInHistory && ` ${t("failureKeptInHistory")}`}
        </p>
      )}
      {(snapshot.failure === "microphone" ||
        snapshot.failure === "nothingHeard") && (
        // Keyed by the failure, so a new one reads its action afresh.
        <DictationInputFix key={snapshot.failure} />
      )}
      <TranscribeRecordingGroup />
      {snapshot.enabled && (
        <>
          <DictationShortcutSection
            change={(command, args) => {
              void change(command, args);
            }}
            focus={focus}
            holdKeyLabel={holdKeyLabel}
            layout={layout}
            onFocusShown={onFocusShown}
            snapshot={snapshot}
          />
          <SettingsSection title={t("groups.transcription")}>
            {snapshot.cloudAvailable ? (
              <DictationDestination
                cloudModel={snapshot.cloudModel}
                destination={snapshot.destination}
                onDestinationChange={(destination) => {
                  void setDestination(destination);
                }}
                onModelChange={(modelId) => {
                  void setCloudModel(modelId);
                }}
              />
            ) : (
              // Without stella AI there is no choice, but where speech goes
              // is still said.
              <SettingsRow
                description={t("destination.localDescription")}
                id="dictation-destination"
                title={t("destination.title")}
              >
                <span className="text-muted-foreground text-sm">
                  {tDestination("local")}
                </span>
              </SettingsRow>
            )}
            {languageHasEffect(snapshot) && (
              <DictationLanguageRow
                language={snapshot.language}
                locale={locale}
                onChange={(language) => {
                  void setLanguage(language);
                }}
              />
            )}
          </SettingsSection>
          <SettingsSection title={t("groups.cleanup")}>
            <SettingsRow
              description={
                snapshot.destination === "cloud"
                  ? t("cleanup.descriptionCloud")
                  : t("cleanup.description")
              }
              id="dictation-cleanup"
              title={t("cleanup.title")}
            >
              <Switch
                aria-describedby={cleanupIds.description}
                aria-labelledby={cleanupIds.label}
                checked={snapshot.cleanup}
                onCheckedChange={(cleanup) => {
                  void setCleanup(cleanup);
                }}
              />
            </SettingsRow>
            {/* What cleanup may also read; offered only while it runs. */}
            <DictationSwitchRow
              checked={snapshot.shareWindowTitle}
              description={t("context.windowTitle.description")}
              disabled={!snapshot.cleanup}
              id="dictation-share-window-title"
              onChange={(enabled) => {
                void setShare("dictation_set_share_window_title", enabled);
              }}
              title={t("context.windowTitle.title")}
            />
            {snapshot.textBeforeCursorAvailable && (
              <DictationSwitchRow
                checked={snapshot.shareTextBeforeCursor}
                description={t("context.textBeforeCursor.description", {
                  limit:
                    DESKTOP_DICTATION_CLEANUP_LIMITS.textBeforeCursorLength,
                })}
                disabled={!snapshot.cleanup}
                id="dictation-share-text-before-cursor"
                onChange={(enabled) => {
                  void setShare(
                    "dictation_set_share_text_before_cursor",
                    enabled,
                  );
                }}
                title={t("context.textBeforeCursor.title")}
              />
            )}
          </SettingsSection>
          {/* stella AI and cleanup take the words; without either, the
              text from the speech model here is spelled with them. */}
          <DictationCustomWords
            onChange={setCustomWords}
            words={snapshot.customWords}
          />
          {/* With stella AI the model is not needed, but a downloaded one
              can still be removed. */}
          {(snapshot.destination === "local" ||
            snapshot.model.status === "ready") && (
            <SettingsSection title={t("groups.thisComputer")}>
              <DictationModelRow
                busy={snapshot.phase !== "idle"}
                model={snapshot.model}
                modelBytes={snapshot.modelBytes}
                onDownload={() => {
                  void download();
                }}
                onRemove={() => {
                  void removeModel();
                }}
                removeFailed={removeFailed}
              />
            </SettingsSection>
          )}
          {snapshot.keepsInHistory && (
            <p className="text-muted-foreground px-1 text-xs">
              {t("keptInHistory")}
            </p>
          )}
        </>
      )}
    </div>
  );
};

/** The key to hold, the microphone, the sounds and the shortcut that types
 *  the last dictation again. */
const DictationShortcutSection = ({
  change,
  focus,
  holdKeyLabel,
  layout,
  onFocusShown,
  snapshot,
}: Pick<DictationFocus, "focus" | "onFocusShown"> & {
  change: (command: string, args: InvokeArgs) => void;
  holdKeyLabel: (holdKey: HoldKey) => string;
  layout: KeyboardLayout | null;
  snapshot: DictationSnapshot;
}) => {
  const t = useTranslations("dictation");
  const locale = useLocale();
  return (
    <SettingsSection title={t("groups.shortcut")}>
      {snapshot.holdKeys.length > 1 && (
        <DictationHoldKeyRow
          holdKey={snapshot.holdKey}
          holdKeys={snapshot.holdKeys}
          label={holdKeyLabel}
          onChange={(holdKey) => {
            change("dictation_set_hold_key", { holdKey });
          }}
        />
      )}
      <DictationMicrophoneRow
        focused={focus === "microphone"}
        onFocused={onFocusShown}
      />
      <DictationSoundsRow
        checked={snapshot.sounds}
        onChange={(sounds) => {
          change("dictation_set_sounds", { enabled: sounds });
        }}
      />
      <DictationRetypeRow
        checked={snapshot.retypeShortcut}
        onChange={(enabled) => {
          change("dictation_set_retype_shortcut", { enabled });
        }}
        shortcut={formatShortcut({
          keys: snapshot.retypeKeys,
          layout,
          locale,
          platform: DESKTOP_PLATFORM,
        })}
        taken={snapshot.retypeShortcutTaken}
      />
    </SettingsSection>
  );
};

/** Where a recording on disk is transcribed: its own window, offered
 *  wherever dictation is, whether or not the shortcut is on. */
const TranscribeRecordingGroup = () => {
  const t = useTranslations("dictation.transcribeRecording");
  const [openFailed, setOpenFailed] = useState(false);
  const open = async () => {
    const result = await Result.tryPromise(async () =>
      invoke("transcribe_open"),
    );
    setOpenFailed(Result.isError(result));
  };
  return (
    <SettingsSection>
      <SettingsRow
        description={t("description")}
        id="dictation-transcribe-recording"
        title={t("title")}
      >
        <Button
          onClick={() => {
            void open();
          }}
          variant="outline"
        >
          {t("open")}
        </Button>
      </SettingsRow>
      {openFailed ? (
        <li
          className="text-destructive-foreground px-4 pb-3 text-xs"
          role="alert"
        >
          {t("failed")}
        </li>
      ) : null}
    </SettingsSection>
  );
};

/** The page's title, what failed and the one action that reads again. */
const DictationReadFailed = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations("dictation");
  const tSettings = useTranslations("settings");
  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader title={t("title")} />
      <div className="flex items-center justify-between gap-4 px-1">
        <p className="text-destructive-foreground text-sm" role="alert">
          {tSettings("errorReadState")}
        </p>
        <Button onClick={onRetry} variant="outline">
          {tSettings("tryAgain")}
        </Button>
      </div>
    </div>
  );
};

/** Which key dictation listens for, from what this computer offers. */
const DictationHoldKeyRow = ({
  holdKey,
  holdKeys,
  label,
  onChange,
}: {
  holdKey: HoldKey;
  holdKeys: readonly HoldKey[];
  label: (holdKey: HoldKey) => string;
  onChange: (holdKey: HoldKey) => void;
}) => {
  const t = useTranslations("dictation.holdKey");
  const ids = settingsRowIds("dictation-hold-key");
  return (
    <SettingsRow
      description={t("description")}
      id="dictation-hold-key"
      title={t("title")}
    >
      <Select
        onValueChange={(value) => {
          if (isHoldKey(value)) {
            onChange(value);
          }
        }}
        value={holdKey}
      >
        <SelectTrigger aria-labelledby={ids.label} className="w-44">
          <SelectValue>
            {(value: unknown) => (isHoldKey(value) ? label(value) : null)}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {holdKeys.map((value) => (
            <SelectItem key={value} value={value}>
              {label(value)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </SettingsRow>
  );
};

/** Whether a short sound marks the start and the end of recording. */
const DictationSoundsRow = ({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (enabled: boolean) => void;
}) => {
  const t = useTranslations("dictation.sounds");
  const ids = settingsRowIds("dictation-sounds");
  return (
    <SettingsRow
      description={t("description")}
      id="dictation-sounds"
      title={t("title")}
    >
      <Switch
        aria-describedby={ids.description}
        aria-labelledby={ids.label}
        checked={checked}
        onCheckedChange={onChange}
      />
    </SettingsRow>
  );
};

/** The shortcut that types the last dictation again; the tray offers the
 *  same whether or not it is on. */
const DictationRetypeRow = ({
  checked,
  onChange,
  shortcut,
  taken,
}: {
  checked: boolean;
  onChange: (enabled: boolean) => void;
  shortcut: string;
  taken: boolean;
}) => {
  const t = useTranslations("dictation.retype");
  const ids = settingsRowIds("dictation-retype");
  return (
    <SettingsRow
      description={
        checked && taken
          ? t("taken", { shortcut })
          : t("description", { shortcut })
      }
      id="dictation-retype"
      title={t("title")}
    >
      <Switch
        aria-describedby={ids.description}
        aria-labelledby={ids.label}
        checked={checked}
        onCheckedChange={onChange}
      />
    </SettingsRow>
  );
};

/** An opt-in switch under AI cleanup, with what it sends; dimmed and
 *  disabled while cleanup is off. */
const DictationSwitchRow = ({
  checked,
  description,
  disabled,
  id,
  onChange,
  title,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  id: string;
  onChange: (enabled: boolean) => void;
  title: string;
}) => {
  const ids = settingsRowIds(id);
  return (
    <SettingsRow
      depth="nested"
      description={description}
      disabled={disabled}
      id={id}
      title={title}
    >
      <Switch
        aria-describedby={ids.description}
        aria-labelledby={ids.label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </SettingsRow>
  );
};

/** Which language dictation expects: automatic (this computer's languages)
 *  or one the speech model lists, named in its own language. */
const DictationLanguageRow = ({
  language,
  locale,
  onChange,
}: {
  language: DictationLanguage;
  locale: string;
  onChange: (language: string) => void;
}) => {
  const t = useTranslations("dictation.language");
  const ids = settingsRowIds("dictation-language-row");
  const items = [AUTOMATIC_LANGUAGE, ...language.supported];
  const automatic =
    language.inferred.length === 0
      ? t("automatic")
      : t("automaticWith", {
          languages: new Intl.ListFormat(locale, {
            type: "conjunction",
          }).format(language.inferred.map((code) => displayLanguageName(code))),
        });
  const label = (item: string) =>
    item === AUTOMATIC_LANGUAGE ? automatic : displayLanguageName(item);

  return (
    <SettingsRow
      description={t("description")}
      id="dictation-language-row"
      title={t("title")}
    >
      <Combobox<string>
        autoHighlight
        items={items}
        itemToStringLabel={label}
        onValueChange={(value) => {
          if (value !== null && value !== language.choice) {
            onChange(value);
          }
        }}
        value={
          items.includes(language.choice) ? language.choice : AUTOMATIC_LANGUAGE
        }
      >
        <ComboboxInput
          aria-describedby={ids.description}
          aria-labelledby={ids.label}
          className="w-60"
          id="dictation-language"
          showTrigger={false}
        />
        <ComboboxPopup align="end">
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem key={item} value={item}>
                {label(item)}
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>{t("noResults")}</ComboboxEmpty>
        </ComboboxPopup>
      </Combobox>
    </SettingsRow>
  );
};

/** The speech model on this computer: its state and the one action that
 *  changes it. Its licence is behind the title. */
const DictationModelRow = ({
  busy,
  model,
  modelBytes,
  onDownload,
  onRemove,
  removeFailed,
}: {
  /** A dictation is running, so the model cannot be removed now. */
  busy: boolean;
  model: DictationModel;
  modelBytes: number;
  onDownload: () => void;
  onRemove: () => void;
  removeFailed: boolean;
}) => {
  const t = useTranslations("dictation");
  const size = Math.round(modelBytes / BYTES_PER_MEGABYTE);

  return (
    <SettingsRow
      description={<DictationModelState model={model} size={size} />}
      footer={
        model.status === "ready" && removeFailed ? (
          <p className="text-destructive-foreground text-xs" role="alert">
            {t("removeFailed")}
          </p>
        ) : null
      }
      id="dictation-model"
      title={
        <Tooltip>
          <TooltipFactTrigger>{t("speechModel")}</TooltipFactTrigger>
          <TooltipPopup className="max-w-72">
            {t("modelAttribution")}
          </TooltipPopup>
        </Tooltip>
      }
    >
      <DictationModelAction
        busy={busy}
        model={model}
        onDownload={onDownload}
        onRemove={onRemove}
        size={size}
      />
    </SettingsRow>
  );
};

const DictationModelState = ({
  model,
  size,
}: {
  model: DictationModel;
  size: number;
}) => {
  const t = useTranslations("dictation");
  switch (model.status) {
    case "ready":
      return t("modelInstalled", { size });
    case "downloading":
      return (
        <span role="status">
          {t("downloading", {
            percent: Math.floor((model.received / model.total) * PERCENT),
          })}
        </span>
      );
    case "failed":
      return t("downloadFailed");
    case "missing":
      return t("modelNeeded");
    default:
      model satisfies never;
      return panic("Unknown speech model status");
  }
};

const DictationModelAction = ({
  busy,
  model,
  onDownload,
  onRemove,
  size,
}: {
  busy: boolean;
  model: DictationModel;
  onDownload: () => void;
  onRemove: () => void;
  size: number;
}) => {
  const t = useTranslations("dictation");
  switch (model.status) {
    case "ready":
      return (
        <Button
          disabled={busy}
          disabledReason={t("dictationInProgress")}
          onClick={onRemove}
          variant="ghost"
        >
          {t("removeModel")}
        </Button>
      );
    case "downloading":
      return null;
    case "failed":
    case "missing":
      return (
        <Button onClick={onDownload} variant="outline">
          {t("download", { size })}
        </Button>
      );
    default:
      model satisfies never;
      return panic("Unknown speech model status");
  }
};
