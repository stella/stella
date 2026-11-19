import { useId } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { useLocale, useTranslations } from "use-intl";

import { DESKTOP_DICTATION_CLEANUP_LIMITS } from "@stll/api-contract/desktop-dictation-cleanup";
import { Button } from "@stll/ui/button";
import { CheckCircle2Icon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Switch } from "@stll/ui/switch";

import { DictationCustomWords } from "../mainview/DictationCustomWords";
import {
  CloudModelSelect,
  DictationModelTags,
  RetentionWarning,
  shownCloudModel,
  unavailableMessage,
  useCloudModels,
} from "../mainview/DictationDestination";
import type { CloudModelOffer } from "../mainview/DictationDestination";
import { PermissionsSection } from "../mainview/PermissionsSection";
import { formatHoldKey } from "../shared/hold-key";
import type { Permission } from "../shared/permissions";
import {
  DESKTOP_PLATFORM,
  useKeyboardLayout,
} from "../shared/use-clipboard-shortcut";
import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import { transcriptionChoices } from "./dictation-setup-steps";
import type {
  DictationDestinationChoice,
  DictationSetupScreen,
} from "./dictation-setup-steps";
import { namedDictationFailure, needsDownload } from "./use-dictation";
import type { DictationControls, DictationSnapshot } from "./use-dictation";

const BYTES_PER_MEGABYTE = 1_000_000;
const PERCENT = 100;

type ScreenProps = {
  controls: DictationControls;
  snapshot: DictationSnapshot;
};

/** One screen of the Dictation step: its title, one plain line under it,
 *  and its choice. */
export const DictationSetupScreenBody = ({
  controls,
  permissions,
  screen,
  snapshot,
}: ScreenProps & {
  /** The permissions the microphone screen asks for. */
  permissions: readonly Permission[];
  screen: DictationSetupScreen;
}) => {
  switch (screen) {
    case "microphone":
      return (
        <MicrophoneScreen
          controls={controls}
          permissions={permissions}
          snapshot={snapshot}
        />
      );
    case "transcription":
      return <TranscriptionScreen controls={controls} snapshot={snapshot} />;
    case "app":
      return <AppScreen controls={controls} snapshot={snapshot} />;
    case "context":
      return <ContextScreen controls={controls} snapshot={snapshot} />;
    case "words":
      return <WordsScreen controls={controls} />;
    default:
      screen satisfies never;
      return panic("Unknown dictation setup screen.");
  }
};

const ScreenHeader = ({ body, title }: { body: ReactNode; title: string }) => (
  <>
    <h1 className="text-xl font-semibold text-balance">{title}</h1>
    <p className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty">
      {body}
    </p>
  </>
);

/** The screen's cards, scrolling inside the window when they outgrow it. */
const ScreenContent = ({ children }: { children: ReactNode }) => (
  <ScrollArea axis="vertical" className="mt-4">
    <div className="flex flex-col gap-3 pb-1">{children}</div>
  </ScrollArea>
);

/** The shortcut as this keyboard and platform write it. */
const useShortcut = (snapshot: DictationSnapshot) => {
  const dictationT = useTranslations("dictation");
  const locale = useLocale();
  const layout = useKeyboardLayout();
  return formatHoldKey({
    holdKey: snapshot.holdKey,
    keys: snapshot.keys,
    layout,
    locale,
    platform: DESKTOP_PLATFORM,
    right: (key: string) => dictationT("holdKey.right", { key }),
  });
};

/** 1. The microphone, then Accessibility on a Mac to type the text. */
const MicrophoneScreen = ({
  permissions,
  snapshot,
}: ScreenProps & { permissions: readonly Permission[] }) => {
  const t = useTranslations("onboarding");
  const dictationT = useTranslations("dictation");
  const shortcut = useShortcut(snapshot);
  const failure = namedDictationFailure(snapshot.failure);
  return (
    <>
      <ScreenHeader
        body={
          permissions.includes("accessibility")
            ? t("dictationSetup.microphone.bodyMac", { shortcut })
            : t("dictationSetup.microphone.body", { shortcut })
        }
        title={t("dictationSetup.microphone.title")}
      />
      <ScreenContent>
        <div className="bg-card overflow-hidden rounded-xl border empty:hidden">
          <PermissionsSection
            descriptions={{
              accessibility: t("dictationAccessibility"),
              microphone: t("dictationMicrophone"),
            }}
            only={permissions}
            window={DESKTOP_TELEMETRY_WINDOWS.onboarding}
          />
        </div>
        {snapshot.shortcutTaken ? (
          <p className="text-destructive-foreground text-sm">
            {dictationT("shortcutTaken", { shortcut })}
          </p>
        ) : null}
        {failure === null ? null : (
          <p className="text-destructive-foreground text-sm" role="status">
            {dictationT(`failure.${failure}`)}
          </p>
        )}
      </ScreenContent>
    </>
  );
};

/** 2. Where speech is transcribed: this computer, or stella AI for an
 *  account that has it. */
const TranscriptionScreen = ({ controls, snapshot }: ScreenProps) => {
  const t = useTranslations("onboarding.dictationSetup.transcription");
  const offersCloud = transcriptionChoices(snapshot).includes("cloud");
  return (
    <>
      <ScreenHeader
        body={offersCloud ? t("body") : t("bodyLocal")}
        title={offersCloud ? t("title") : t("titleLocal")}
      />
      <ScreenContent>
        {offersCloud ? (
          <TranscriptionChoice controls={controls} snapshot={snapshot} />
        ) : (
          <div
            className="bg-card rounded-xl border p-3"
            data-destination="local"
          >
            <DestinationHeading choice="local" reason={null} />
            <div className="mt-3">
              <LocalModel
                controls={controls}
                offersDownload
                snapshot={snapshot}
              />
            </div>
          </div>
        )}
      </ScreenContent>
    </>
  );
};

/** This computer or stella AI, as two cards of one choice. */
const TranscriptionChoice = ({ controls, snapshot }: ScreenProps) => {
  const t = useTranslations("onboarding.dictationSetup.transcription");
  const cloud = useCloudModels();
  const name = useId();
  const cloudUnavailable = cloud.offered === null && cloud.reason !== null;
  return (
    <div
      aria-label={t("title")}
      className="flex flex-col gap-3"
      role="radiogroup"
    >
      {(["local", "cloud"] as const).map((choice) => {
        const chosen = snapshot.destination === choice;
        return (
          <div
            className="bg-card has-checked:border-primary rounded-xl border"
            data-destination={choice}
            key={choice}
          >
            <Label
              className="items-start gap-3 rounded-xl p-3 hover:bg-transparent"
              variant="choice"
            >
              <input
                checked={chosen}
                className="accent-primary mt-0.5 size-4 shrink-0"
                disabled={choice === "cloud" && cloudUnavailable && !chosen}
                name={name}
                onChange={() => {
                  void controls.setDestination(choice);
                }}
                type="radio"
                value={choice}
              />
              <DestinationHeading
                choice={choice}
                reason={choice === "cloud" ? cloud.reason : null}
              />
            </Label>
            {choice === "local" ? (
              <div className="px-3 ps-10 pb-3">
                <LocalModel
                  controls={controls}
                  offersDownload={chosen}
                  snapshot={snapshot}
                />
              </div>
            ) : null}
            {choice === "cloud" && chosen && cloud.offered !== null ? (
              <div className="px-3 ps-10 pb-3">
                <CloudModel
                  cloudModel={snapshot.cloudModel}
                  controls={controls}
                  offered={cloud.offered}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

/** A place speech can be transcribed and what that means for the audio;
 *  for stella AI, why it is not offered when it is not. */
const DestinationHeading = ({
  choice,
  reason,
}: {
  choice: DictationDestinationChoice;
  reason: CloudModelOffer["reason"];
}) => {
  const t = useTranslations("onboarding.dictationSetup.transcription");
  const destinationT = useTranslations("dictation.destination");
  return (
    <span className="min-w-0">
      <span className="text-foreground block text-sm font-medium">
        {choice === "local" ? t("localTitle") : t("cloudTitle")}
      </span>
      <span className="text-muted-foreground mt-0.5 block text-sm leading-relaxed text-pretty">
        {choice === "local" ? t("localBody") : t("cloudBody")}
      </span>
      {reason === null ? null : (
        <span className="text-muted-foreground mt-1 block text-xs" role="note">
          {destinationT(unavailableMessage(reason))}
        </span>
      )}
    </span>
  );
};

/** The speech model on this computer: its size and download, or that it
 *  is in place. */
const LocalModel = ({
  controls,
  offersDownload,
  snapshot,
}: ScreenProps & {
  /** Off while stella AI is chosen: the size still shows, the button
   *  waits for this computer to be chosen. */
  offersDownload: boolean;
}) => {
  const t = useTranslations("onboarding");
  const dictationT = useTranslations("dictation");
  const size = Math.round(snapshot.modelBytes / BYTES_PER_MEGABYTE);
  const { model } = snapshot;
  if (model.status === "ready") {
    return (
      <p className="flex items-center gap-2 text-sm">
        <CheckCircle2Icon
          aria-hidden="true"
          className="text-success-foreground size-4 shrink-0"
        />
        {dictationT("modelInstalled", { size })}
      </p>
    );
  }
  if (model.status === "downloading") {
    const percent = Math.floor((model.received / model.total) * PERCENT);
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm tabular-nums" role="status">
          {dictationT("downloading", { percent })}
        </p>
        <div
          aria-hidden="true"
          className="bg-muted h-1.5 overflow-hidden rounded-full"
        >
          <div
            className="bg-foreground h-full rounded-full"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          {t("dictationDownloadContinues")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground min-w-0 flex-1 text-sm">
        {model.status === "failed"
          ? dictationT("downloadFailed")
          : t("dictationSetup.transcription.localModel", { size })}
      </p>
      {offersDownload ? (
        <Button
          className="shrink-0"
          disabled={!needsDownload(model)}
          onClick={() => {
            void controls.download();
          }}
          variant="outline"
        >
          {dictationT("download", { size })}
        </Button>
      ) : null}
    </div>
  );
};

/** The stella AI model: the region's list, the chosen model's labels, and
 *  the warning when its provider keeps the audio. */
const CloudModel = ({
  cloudModel,
  controls,
  offered,
}: {
  cloudModel: string | null;
  controls: DictationControls;
  offered: NonNullable<CloudModelOffer["offered"]>;
}) => {
  const destinationT = useTranslations("dictation.destination");
  const labelId = useId();
  const chosen = shownCloudModel(offered, cloudModel);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium" id={labelId}>
            {destinationT("model")}
          </p>
          {chosen === null ? null : <DictationModelTags model={chosen} />}
        </div>
        <CloudModelSelect
          chosen={chosen}
          cloudModel={cloudModel}
          labelledBy={labelId}
          models={offered.models}
          onModelChange={(modelId) => {
            void controls.setCloudModel(modelId);
          }}
        />
      </div>
      {chosen?.retainsData === true ? (
        <RetentionWarning provider={chosen.provider ?? chosen.displayName} />
      ) : null}
    </div>
  );
};

/** A switch with its name and what it sends, on a card of its own. */
const SwitchCard = ({
  checked,
  description,
  onChange,
  title,
}: {
  checked: boolean;
  description: string;
  onChange: (enabled: boolean) => void;
  title: string;
}) => {
  const id = useId();
  return (
    <div className="bg-card flex items-center justify-between gap-4 rounded-xl border px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" id={`${id}-title`}>
          {title}
        </p>
        <p
          className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty"
          id={`${id}-description`}
        >
          {description}
        </p>
      </div>
      <Switch
        aria-describedby={`${id}-description`}
        aria-labelledby={`${id}-title`}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
};

/** What a screen sends and keeps, one plain line each. */
const Facts = ({ facts }: { facts: readonly string[] }) => (
  <ul className="text-muted-foreground flex flex-col gap-1.5 px-1 text-sm">
    {facts.map((fact) => (
      <li className="flex gap-2" key={fact}>
        <span
          aria-hidden="true"
          className="bg-muted-foreground mt-2 size-1 shrink-0 rounded-full"
        />
        <span className="min-w-0 text-pretty">{fact}</span>
      </li>
    ))}
  </ul>
);

/** 3. AI cleanup, which fits the text to the kind of app it goes to. */
const AppScreen = ({ controls, snapshot }: ScreenProps) => {
  const t = useTranslations("onboarding.dictationSetup.app");
  const dictationT = useTranslations("dictation");
  return (
    <>
      <ScreenHeader body={t("body")} title={t("title")} />
      <ScreenContent>
        <SwitchCard
          checked={snapshot.cleanup}
          description={
            snapshot.destination === "cloud"
              ? dictationT("cleanup.descriptionCloud")
              : dictationT("cleanup.description")
          }
          onChange={(enabled) => {
            void controls.setCleanup(enabled);
          }}
          title={dictationT("cleanup.title")}
        />
        <Facts
          facts={
            snapshot.cleanup ? [t("sentAppKind"), t("notStored")] : [t("off")]
          }
        />
      </ScreenContent>
    </>
  );
};

/** 4. The window title and the text before the cursor, each opt-in. */
const ContextScreen = ({ controls, snapshot }: ScreenProps) => {
  const t = useTranslations("onboarding.dictationSetup.context");
  const dictationT = useTranslations("dictation.context");
  return (
    <>
      <ScreenHeader body={t("body")} title={t("title")} />
      <ScreenContent>
        <SwitchCard
          checked={snapshot.shareWindowTitle}
          description={dictationT("windowTitle.description")}
          onChange={(enabled) => {
            void controls.setShare("windowTitle", enabled);
          }}
          title={dictationT("windowTitle.title")}
        />
        {snapshot.textBeforeCursorAvailable ? (
          <SwitchCard
            checked={snapshot.shareTextBeforeCursor}
            description={dictationT("textBeforeCursor.description", {
              limit: DESKTOP_DICTATION_CLEANUP_LIMITS.textBeforeCursorLength,
            })}
            onChange={(enabled) => {
              void controls.setShare("textBeforeCursor", enabled);
            }}
            title={dictationT("textBeforeCursor.title")}
          />
        ) : null}
      </ScreenContent>
    </>
  );
};

const WORD_EXAMPLES = ["firm", "client", "term"] as const;

/** 5. Custom words, with a few ideas for what to add; none is added for
 *  the speaker. */
const WordsScreen = ({ controls }: Pick<ScreenProps, "controls">) => {
  const t = useTranslations("onboarding.dictationSetup.words");
  return (
    <>
      <ScreenHeader body={t("body")} title={t("title")} />
      <ScreenContent>
        <DictationCustomWords
          examples={{
            label: t("examplesLabel"),
            options: WORD_EXAMPLES.map((example) => t(`examples.${example}`)),
          }}
          onChange={controls.setCustomWords}
          showGroupTitle={false}
          words={controls.snapshot?.customWords ?? []}
        />
      </ScreenContent>
    </>
  );
};
