import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

export type DictationDestinationValue = "local" | "cloud";

type CloudModels = {
  defaultModelId: string | null;
  models: { displayName: string; id: string }[];
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

/** Where dictation is transcribed: this computer (the default) or stella AI,
 *  with a model the organization's region offers. stella AI is offered only
 *  when the region has a model, and says why otherwise. */
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
  const reason = (() => {
    if (models.status === "loading" || offered !== null) {
      return null;
    }
    if (
      models.status === "loaded" &&
      models.models.unavailable === "provider"
    ) {
      return t("unavailableProvider");
    }
    if (models.status === "loaded") {
      return t("unavailableRegion");
    }
    return t("unavailable");
  })();
  const label = (value: DictationDestinationValue) =>
    value === "local" ? t("local") : t("cloud");
  const selectedModel =
    offered === null
      ? null
      : (offered.models.find(({ id }) => id === cloudModel)?.id ??
        offered.defaultModelId ??
        offered.models[0]?.id ??
        null);

  const modelChoice =
    destination === "cloud" && offered !== null && selectedModel !== null
      ? { models: offered.models, selected: selectedModel }
      : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium" id="dictation-destination-label">
            {t("title")}
          </p>
          {destination === "cloud" && (
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
              {t("cloudDescription")}
            </p>
          )}
          {reason !== null && (
            <p
              className="text-muted-foreground mt-1 text-sm leading-relaxed"
              role="note"
            >
              {reason}
            </p>
          )}
        </div>
        <Select
          onValueChange={(value) => {
            if (value === "local" || value === "cloud") {
              onDestinationChange(value);
            }
          }}
          value={destination}
        >
          <SelectTrigger
            aria-labelledby="dictation-destination-label"
            className="w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {DESTINATIONS.map((value) => (
              <SelectItem
                disabled={
                  value === "cloud" &&
                  offered === null &&
                  destination !== "cloud"
                }
                key={value}
                value={value}
              >
                {label(value)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {modelChoice !== null && (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium" id="dictation-cloud-model-label">
            {t("model")}
          </p>
          <Select
            onValueChange={(value) => {
              // Compared with what is stored, not what is shown: the shown
              // default of a missing or stale choice is kept once picked.
              if (typeof value === "string" && value !== cloudModel) {
                onModelChange(value);
              }
            }}
            value={modelChoice.selected}
          >
            <SelectTrigger
              aria-labelledby="dictation-cloud-model-label"
              className="w-56"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {modelChoice.models.map(({ displayName, id }) => (
                <SelectItem key={id} value={id}>
                  {displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}
    </div>
  );
};
