import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Field, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { ScrollArea } from "@stll/ui/scroll-area";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import {
  isFixRequest,
  isFixSaved,
  pickWords,
  placed,
  wordRange,
} from "./dictation-fix";
import type { FixRefusal, FixRequest, WordRange } from "./dictation-fix";

/** Mirrors `CHANGED_EVENT` in `dictation_fix.rs`; payload-free. */
const FIX_CHANGED_EVENT = "dictation-fix-changed";

/**
 * The panel that fixes the spelling of dictated words: the words selected
 * in the app the speaker works in, or else the words of the last dictation
 * to pick from, and a field for how they are written. Saving teaches stella
 * the fix; the native side closes the panel then.
 */
const DictationFixApp = () => {
  const t = useTranslations("dictation.fixPanel");
  const [request, setRequest] = useState<FixRequest | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [picked, setPicked] = useState<WordRange | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ status: "editing" });

  useEffect(() => {
    let disposed = false;
    const read = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_fix_get_state"),
      );
      if (disposed) {
        return;
      }
      const next =
        Result.isOk(result) && isFixRequest(result.value)
          ? result.value
          : { lastWords: [], selection: null };
      if (Result.isError(result)) {
        reportFailure();
      }
      setRequest(next);
      setFrom(next.selection ?? "");
      setTo(next.selection ?? "");
      setPicked(null);
      setOutcome({ status: "editing" });
    };
    const stopListening = subscribeDesktopEvent({
      event: FIX_CHANGED_EVENT,
      handler: () => {
        void read();
      },
      onError: reportFailure,
    });
    void read();
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  const save = async () => {
    setOutcome({ status: "saving" });
    const result = await Result.tryPromise(async () =>
      invoke<unknown>("dictation_fix_save", { from, to }),
    );
    if (Result.isError(result) || !isFixSaved(result.value)) {
      reportFailure();
      setOutcome({ status: "notSaved" });
      return;
    }
    const saved = result.value;
    switch (saved.status) {
      case "saved":
        setOutcome({ status: "editing" });
        return;
      case "refused":
        setOutcome({ reason: saved.reason, status: "refused" });
        return;
      case "notSaved":
        setOutcome({ status: "notSaved" });
        return;
      default:
        saved satisfies never;
        panic("Unhandled dictation fix answer");
    }
  };

  const pick = (index: number) => {
    if (request === null) {
      return;
    }
    const range = wordRange(picked, index);
    const words = pickWords(request.lastWords, range);
    setPicked(range);
    setFrom(words);
    setTo(words);
    setOutcome({ status: "editing" });
  };

  return (
    <main className="dictation-fix-window bg-background text-foreground flex h-dvh flex-col gap-3 rounded-2xl border p-4">
      <Form
        className="min-h-0 flex-1"
        density="snug"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            close();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-sm font-medium">{t("title")}</p>
        {request !== null &&
          request.selection === null &&
          request.lastWords.length > 0 && (
            <LastWords
              onPick={pick}
              picked={picked}
              words={request.lastWords}
            />
          )}
        {request !== null &&
          request.selection === null &&
          request.lastWords.length === 0 && (
            <p className="text-muted-foreground text-xs">{t("nothing")}</p>
          )}
        <Field>
          <FieldLabel>{t("dictatedAs")}</FieldLabel>
          <Input
            onChange={(event) => {
              setFrom(event.target.value);
              setOutcome({ status: "editing" });
            }}
            spellCheck={false}
            value={from}
          />
        </Field>
        <Field>
          <FieldLabel>{t("writtenAs")}</FieldLabel>
          <Input
            autoFocus
            onChange={(event) => {
              setTo(event.target.value);
              setOutcome({ status: "editing" });
            }}
            spellCheck={false}
            value={to}
          />
        </Field>
        <OutcomeLine outcome={outcome} />
        <p className="text-muted-foreground text-xs">{t("hint")}</p>
        <div className="mt-auto flex justify-end gap-2">
          <Button onClick={close} size="sm" type="button" variant="outline">
            {t("cancel")}
          </Button>
          <Button
            disabled={outcome.status === "saving"}
            disabledReason={t("saving")}
            size="sm"
            type="submit"
          >
            {t("save")}
          </Button>
        </div>
      </Form>
    </main>
  );
};

/** The words of the last dictation; picking one, then a neighbour, takes
 *  a phrase. */
const LastWords = ({
  onPick,
  picked,
  words,
}: {
  onPick: (index: number) => void;
  picked: WordRange | null;
  words: readonly string[];
}) => {
  const t = useTranslations("dictation.fixPanel");
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <p className="text-muted-foreground text-xs">{t("pick")}</p>
      <ScrollArea axis="vertical" className="max-h-24">
        <div className="flex flex-wrap gap-1">
          {placed(words).map(({ place, word }) => (
            <Button
              key={place}
              onClick={() => {
                onPick(place);
              }}
              size="xs"
              type="button"
              variant={
                picked !== null && place >= picked.start && place <= picked.end
                  ? "default"
                  : "outline"
              }
            >
              {word}
            </Button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};

const OutcomeLine = ({ outcome }: { outcome: Outcome }) => {
  const t = useTranslations("dictation.fixPanel");
  switch (outcome.status) {
    case "editing":
    case "saving":
      return null;
    case "refused":
      return (
        <p className="text-destructive-foreground text-xs" role="alert">
          {t(REFUSAL_MESSAGES[outcome.reason])}
        </p>
      );
    case "notSaved":
      return (
        <p className="text-destructive-foreground text-xs" role="alert">
          {t("notSaved")}
        </p>
      );
    default:
      outcome satisfies never;
      return panic("Unhandled dictation fix outcome");
  }
};

/** The catalogue key that says why words cannot be a fix. */
const REFUSAL_MESSAGES = {
  empty: "refused.empty",
  lineBreak: "refused.lineBreak",
  same: "refused.same",
  tooLong: "refused.tooLong",
  tooManyWords: "refused.tooManyWords",
} as const satisfies Record<FixRefusal, string>;

type Outcome =
  | { status: "editing" }
  | { status: "saving" }
  | { reason: FixRefusal; status: "refused" }
  | { status: "notSaved" };

const close = () => {
  void Result.tryPromise(async () => invoke("dictation_fix_close")).then(
    (result) => {
      if (Result.isError(result)) {
        reportFailure();
      }
      return;
    },
  );
};

const reportFailure = () => {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
    window: DESKTOP_TELEMETRY_WINDOWS.main,
  });
};

export default DictationFixApp;
