import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  countDictationCodePoints,
  DESKTOP_DICTATION_CLEANUP_LIMITS,
  desktopDictationCleanupModelsSchema,
} from "@stll/api-contract/desktop-dictation-cleanup";
import type { DesktopDictationCleanupModels } from "@stll/api-contract/desktop-dictation-cleanup";
import { BidiText } from "@stll/ui/bidi-text";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { SettingsRow, settingsRowIds } from "@stll/ui/settings";
import { Textarea } from "@stll/ui/textarea";

/** The select's value for automatic: no model chosen. Not a picker value,
 *  which always names its provider (`provider::model`). */
const AUTOMATIC = "automatic";

type ModelsState =
  | { status: "loading" | "failed" }
  | { models: DesktopDictationCleanupModels["models"]; status: "loaded" };

/** Reads the organization's cleanup models once. */
const useCleanupModels = (): ModelsState => {
  const [state, setState] = useState<ModelsState>({ status: "loading" });
  useEffect(() => {
    let disposed = false;
    // A named function, not one invoked in place: an inline call is read as
    // running before the cleanup below can ever set `disposed`.
    const load = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_get_cleanup_models"),
      );
      if (disposed) {
        return;
      }
      const parsed = Result.isOk(result)
        ? v.safeParse(desktopDictationCleanupModelsSchema, result.value)
        : null;
      setState(
        parsed?.success === true
          ? { status: "loaded", models: parsed.output.models }
          : { status: "failed" },
      );
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);
  return state;
};

/**
 * The model cleanup runs on: automatic (the organization's fast model) or
 * one of the models the organization's chat model picker offers. Shown once
 * the organization offers any. A stored model it no longer offers is said to
 * be replaced by automatic, which the server does on every cleanup, until
 * another is picked.
 */
export const DictationCleanupModelRow = ({
  cleanupModel,
  onChange,
}: {
  cleanupModel: string | null;
  onChange: (model: string | null) => Promise<boolean>;
}) => {
  const t = useTranslations("dictation.cleanupModel");
  const ids = settingsRowIds("dictation-cleanup-model");
  const state = useCleanupModels();
  // An empty offer hides the row only when nothing is stored: a stored model
  // the organization stopped offering keeps the row, so the speaker sees it
  // replaced by automatic and can clear it.
  if (
    state.status !== "loaded" ||
    (state.models.length === 0 && cleanupModel === null)
  ) {
    return null;
  }
  const chosen =
    cleanupModel === null
      ? null
      : (state.models.find(({ value }) => value === cleanupModel) ?? null);
  const withdrawn = cleanupModel !== null && chosen === null;
  const description = () => {
    if (withdrawn) {
      return (
        <span className="block" role="note">
          {t("withdrawn")}
        </span>
      );
    }
    return chosen === null ? t("automaticDescription") : t("chosenDescription");
  };
  return (
    <SettingsRow
      depth="nested"
      description={description()}
      id="dictation-cleanup-model"
      title={t("title")}
    >
      <Select
        onValueChange={(value) => {
          if (typeof value !== "string") {
            return;
          }
          const next = value === AUTOMATIC ? null : value;
          if (next !== cleanupModel) {
            void onChange(next);
          }
        }}
        value={chosen?.value ?? AUTOMATIC}
      >
        <SelectTrigger
          aria-describedby={ids.description}
          aria-labelledby={ids.label}
          className="w-44"
        >
          <SelectValue>
            {(value: unknown) =>
              state.models.find((model) => model.value === value)
                ?.displayName ?? t("automatic")
            }
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={AUTOMATIC}>{t("automatic")}</SelectItem>
          {state.models.map((model) => (
            <SelectItem key={model.value} value={model.value}>
              <BidiText as="span">{model.displayName}</BidiText>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </SettingsRow>
  );
};

const INSTRUCTIONS_LIMIT =
  DESKTOP_DICTATION_CLEANUP_LIMITS.customInstructionsLength;

/** Characters as the contract counts them: code points, not UTF-16 units,
 *  counted by the contract's own helper. */
const codePoints = countDictationCodePoints;

/**
 * What the speaker wants cleanup to follow, saved when the field is left.
 * The field holds at most the contract's length in code points, the unit the
 * contract and the native side count; the native side refuses anything
 * longer whole rather than cutting it.
 *
 * The row follows what is stored without remounting: a stored value that
 * changes, from elsewhere or as this row's own save coming back, replaces the
 * draft only while the draft holds no edit made since the last stored value.
 */
export const DictationCleanupInstructionsRow = ({
  instructions,
  onSave,
}: {
  instructions: string | null;
  onSave: (instructions: string | null) => Promise<boolean>;
}) => {
  const t = useTranslations("dictation.cleanupInstructions");
  const ids = settingsRowIds("dictation-cleanup-instructions");
  const stored = instructions ?? "";
  const [draft, setDraft] = useState(stored);
  const [synced, setSynced] = useState(stored);
  const [failed, setFailed] = useState(false);
  if (synced !== stored) {
    setSynced(stored);
    if (draft === synced) {
      setDraft(stored);
    }
  }
  const save = async () => {
    const next = draft.trim() === "" ? null : draft;
    if ((next ?? "") === (instructions ?? "")) {
      return;
    }
    setFailed(!(await onSave(next)));
  };
  return (
    <SettingsRow
      depth="nested"
      description={t("description")}
      footer={
        <>
          <Textarea
            aria-describedby={ids.description}
            aria-invalid={failed || undefined}
            aria-labelledby={ids.label}
            maxRows={8}
            onBlur={() => {
              void save();
            }}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (codePoints(next) > INSTRUCTIONS_LIMIT) {
                return;
              }
              setDraft(next);
              setFailed(false);
            }}
            placeholder={t("placeholder")}
            rows={3}
            value={draft}
          />
          <p
            className="text-muted-foreground mt-1 text-end text-xs tabular-nums"
            data-slot="textarea-count"
          >
            {codePoints(draft)}/{INSTRUCTIONS_LIMIT}
          </p>
          {failed && (
            <p
              className="text-destructive-foreground mt-1.5 text-xs"
              role="alert"
            >
              {t("saveFailed")}
            </p>
          )}
        </>
      }
      id="dictation-cleanup-instructions"
      title={t("title")}
    />
  );
};
