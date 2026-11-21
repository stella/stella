import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { Badge } from "@stll/ui/badge";
import { TriangleAlertIcon } from "@stll/ui/icons";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { SettingsRow, settingsRowIds } from "@stll/ui/settings";
import { ToggleGroup, ToggleGroupItem } from "@stll/ui/toggle-group";

export type DictationDestinationValue = "local" | "cloud";

type CloudModel = {
  displayName: string;
  id: string;
  /** Who runs the model; absent from older APIs. */
  provider?: string | null;
  /** The model processes audio outside the organization's region. */
  outsideRegion?: boolean;
  /** The provider keeps the audio and transcript: its account has no zero
   *  data retention. */
  retainsData?: boolean;
};

type CloudModels = {
  defaultModelId: string | null;
  models: CloudModel[];
  unavailable: "provider" | "region" | null;
};

type ModelsState =
  | { status: "loading" }
  | { status: "failed" }
  | { models: CloudModels; status: "loaded" };

const isCloudModels = (value: unknown): value is CloudModels =>
  typeof value === "object" &&
  value !== null &&
  "models" in value &&
  Array.isArray(value.models) &&
  "defaultModelId" in value &&
  "unavailable" in value;

const DESTINATIONS = [
  "local",
  "cloud",
] as const satisfies readonly DictationDestinationValue[];

/** The region's stella AI models as the destination choice reads them:
 *  the models on offer, or why there are none. */
export type CloudModelOffer = {
  /** Null while loading, or when stella AI is not offered. */
  offered: CloudModels | null;
  /** Why stella AI is not offered; null while loading or when it is. */
  reason: "provider" | "region" | "unavailable" | null;
};

/** Reads the region's stella AI models once. */
export const useCloudModels = (): CloudModelOffer => {
  const [models, setModels] = useState<ModelsState>({ status: "loading" });

  useEffect(() => {
    let disposed = false;
    // A named function, not one invoked in place: an inline call is read as
    // running before the cleanup below can ever set `disposed`.
    const load = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_get_cloud_models"),
      );
      if (disposed) {
        return;
      }
      setModels(
        Result.isOk(result) && isCloudModels(result.value)
          ? { status: "loaded", models: result.value }
          : { status: "failed" },
      );
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);

  const offered =
    models.status === "loaded" &&
    models.models.unavailable === null &&
    models.models.models.length > 0
      ? models.models
      : null;
  if (models.status === "loading" || offered !== null) {
    return { offered, reason: null };
  }
  if (models.status === "loaded" && models.models.unavailable === "provider") {
    return { offered, reason: "provider" };
  }
  return {
    offered,
    reason: models.status === "loaded" ? "region" : "unavailable",
  };
};

/** The message key under `dictation.destination` for why stella AI is not
 *  offered. */
export const unavailableMessage = (
  reason: NonNullable<CloudModelOffer["reason"]>,
) => {
  switch (reason) {
    case "provider":
      return "unavailableProvider";
    case "region":
      return "unavailableRegion";
    case "unavailable":
      return "unavailable";
    default:
      reason satisfies never;
      return panic("Unknown stella AI unavailability.");
  }
};

/** The model shown as chosen: the stored one, else the region's default,
 *  else the first on offer. A model whose provider keeps the audio is shown
 *  only once picked, never as the fallback for a missing or stale choice. */
export const shownCloudModel = (
  offered: CloudModels,
  cloudModel: string | null,
): CloudModel | null =>
  offered.models.find(({ id }) => id === cloudModel) ??
  offered.models.find(
    ({ id, retainsData }) =>
      id === offered.defaultModelId && retainsData !== true,
  ) ??
  offered.models.find(({ retainsData }) => retainsData !== true) ??
  null;

/** Where dictation is transcribed: this computer (the default) or stella AI,
 *  with a model the organization's region offers. stella AI is offered only
 *  when the region has a model, and says why otherwise. Renders the rows of
 *  the Transcription group. */
export const DictationDestination = ({
  cloudModel,
  destination,
  onDestinationChange,
  onModelChange,
}: {
  cloudModel: string | null;
  destination: DictationDestinationValue;
  onDestinationChange: (destination: DictationDestinationValue) => void;
  onModelChange: (modelId: string) => void;
}) => {
  const t = useTranslations("dictation.destination");
  const { offered, reason } = useCloudModels();
  const label = (value: DictationDestinationValue) =>
    value === "local" ? t("local") : t("cloud");
  const chosen =
    destination === "cloud" && offered !== null
      ? shownCloudModel(offered, cloudModel)
      : null;
  const destinationIds = settingsRowIds("dictation-destination");
  const modelIds = settingsRowIds("dictation-cloud-model");

  return (
    <>
      <SettingsRow
        description={
          <>
            {destination === "cloud"
              ? t("cloudDescription")
              : t("localDescription")}
            {reason === null ? null : (
              <span className="mt-0.5 block" role="note">
                {t(unavailableMessage(reason))}
              </span>
            )}
          </>
        }
        id="dictation-destination"
        title={t("title")}
      >
        <ToggleGroup
          aria-describedby={destinationIds.description}
          aria-labelledby={destinationIds.label}
          onValueChange={(values) => {
            // The pressed item can be clicked off; one is always chosen.
            const next = values.at(0);
            if (next !== undefined && next !== destination) {
              onDestinationChange(next);
            }
          }}
          size="sm"
          value={[destination]}
        >
          {DESTINATIONS.map((value) => (
            <ToggleGroupItem
              disabled={
                value === "cloud" && offered === null && destination !== "cloud"
              }
              key={value}
              value={value}
            >
              {label(value)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingsRow>
      {destination === "cloud" && offered !== null && (
        <SettingsRow
          description={
            chosen === null ? null : <DictationModelTags model={chosen} />
          }
          footer={
            chosen?.retainsData === true ? (
              <RetentionWarning
                provider={chosen.provider ?? chosen.displayName}
              />
            ) : null
          }
          id="dictation-cloud-model"
          title={t("model")}
        >
          <CloudModelSelect
            chosen={chosen}
            cloudModel={cloudModel}
            labelledBy={modelIds.label}
            models={offered.models}
            onModelChange={onModelChange}
          />
        </SettingsRow>
      )}
    </>
  );
};

/** The stella AI model list: each named with who runs it, whether it
 *  leaves the region and whether its provider keeps the audio. */
export const CloudModelSelect = ({
  chosen,
  cloudModel,
  labelledBy,
  models,
  onModelChange,
}: {
  chosen: CloudModel | null;
  cloudModel: string | null;
  labelledBy: string;
  models: readonly CloudModel[];
  onModelChange: (modelId: string) => void;
}) => {
  const t = useTranslations("dictation.destination");
  const modelLabel = ({
    displayName,
    outsideRegion,
    provider,
    retainsData,
  }: CloudModel) =>
    [
      displayName,
      provider,
      outsideRegion === true ? t("outsideRegion") : null,
      retainsData === true ? t("retainsData") : null,
    ]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(" · ");
  return (
    <Select
      onValueChange={(value) => {
        // Compared with what is stored, not what is shown: the shown
        // default of a missing or stale choice is kept once picked.
        if (typeof value === "string" && value !== cloudModel) {
          onModelChange(value);
        }
      }}
      value={chosen?.id ?? null}
    >
      <SelectTrigger aria-labelledby={labelledBy} className="w-44">
        <SelectValue>
          {(value: unknown) =>
            models.find(({ id }) => id === value)?.displayName ??
            t("chooseModel")
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {models.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {modelLabel(model)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

/** Who runs the chosen model, whether it leaves the region, and whether its
 *  provider keeps the audio. */
export const DictationModelTags = ({ model }: { model: CloudModel }) => {
  const t = useTranslations("dictation.destination");
  return (
    <span className="mt-1 flex flex-wrap gap-1.5">
      {model.provider ? <Badge>{model.provider}</Badge> : null}
      {model.outsideRegion === true ? (
        <Badge>{t("outsideRegion")}</Badge>
      ) : null}
      {model.retainsData === true ? (
        <Badge dot tone="warning">
          {t("retainsData")}
        </Badge>
      ) : null}
    </span>
  );
};

/** The page's one accent: the chosen model's provider keeps what is
 *  dictated. */
export const RetentionWarning = ({ provider }: { provider: string }) => {
  const t = useTranslations("dictation.destination");
  return (
    <div
      className="border-warning/32 bg-warning/8 text-warning-foreground flex gap-2.5 rounded-lg border px-3 py-2.5"
      role="alert"
    >
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5 text-xs text-pretty">
        <p className="font-semibold">{t("retainsDataTitle", { provider })}</p>
        <p>{t("retainsDataWarning", { provider })}</p>
      </div>
    </div>
  );
};
