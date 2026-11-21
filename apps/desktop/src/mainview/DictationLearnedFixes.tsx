import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  SettingsRow,
  settingsRowIds,
  SettingsSection,
} from "@stll/ui/settings";
import { Switch } from "@stll/ui/switch";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import { isLearnedView, listedFixes } from "./dictation-learned";
import type { LearnedFix } from "./dictation-learned";

/** Mirrors `CHANGED_EVENT` in `dictation_learned.rs`; payload-free. */
const LEARNED_CHANGED_EVENT = "dictation-learned-changed";
const ROW_ID = "dictation-learned";

/**
 * The fixes stella learned for how the speaker spells dictated words, each
 * with a switch, and a way to delete them all, here and on the speaker's
 * other devices. Fixes still being learned, or corrected another way, are
 * not listed; deleting removes them too. When the list cannot be read it
 * says so, with a way to try again, and deleting still works.
 */
export const DictationLearnedFixes = ({ shortcut }: { shortcut: string }) => {
  const t = useTranslations("dictation.learned");
  const [stored, setStored] = useState<Stored>({ status: "reading" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ids = settingsRowIds(ROW_ID);

  const read = async () => {
    setStored(await readLearned());
  };

  useEffect(() => {
    let disposed = false;
    const reread = async () => {
      const next = await readLearned();
      if (!disposed) {
        setStored(next);
      }
    };
    const stopListening = subscribeDesktopEvent({
      event: LEARNED_CHANGED_EVENT,
      handler: () => {
        void reread();
      },
      onError: reportFailure,
    });
    void reread();
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  /** Runs a change; its answer is the list it leaves. */
  const run = async (change: () => Promise<unknown>) => {
    setBusy(true);
    const result = await Result.tryPromise(change);
    setBusy(false);
    setFailed(Result.isError(result));
    if (Result.isOk(result) && isLearnedView(result.value)) {
      setStored({ fixes: result.value.fixes, status: "read" });
    } else {
      reportFailure();
    }
  };

  const all = stored.status === "read" ? stored.fixes : [];
  const listed = listedFixes(all);
  const nothingToDelete = stored.status === "read" && all.length === 0;

  return (
    <SettingsSection title={t("group")}>
      <SettingsRow
        description={t("description", { shortcut })}
        footer={<LearnedProblem failed={failed} stored={stored} />}
        id={ROW_ID}
        title={t("title")}
      >
        {stored.status === "unreadable" ? (
          <Button
            disabled={busy}
            disabledReason={t("working")}
            onClick={() => {
              void read();
            }}
            variant="ghost"
          >
            {t("retry")}
          </Button>
        ) : null}
      </SettingsRow>
      {stored.status === "read" && listed.length === 0 ? (
        <li className="text-muted-foreground px-4 pb-3 text-xs">
          {t("empty")}
        </li>
      ) : null}
      {listed.map((fix) => (
        <LearnedFixRow
          busy={busy}
          fix={fix}
          key={fix.from}
          onSwitch={(status) => {
            void run(async () =>
              invoke<unknown>("dictation_learned_switch", {
                from: fix.from,
                status,
              }),
            );
          }}
        />
      ))}
      <li className="px-4 py-2.5">
        <Button
          aria-describedby={ids.description}
          disabled={busy || nothingToDelete}
          disabledReason={busy ? t("working") : t("empty")}
          onClick={() => {
            void run(async () => invoke<unknown>("dictation_learned_delete"));
          }}
          variant="outline"
        >
          {t("delete")}
        </Button>
      </li>
    </SettingsSection>
  );
};

const LearnedFixRow = ({
  busy,
  fix,
  onSwitch,
}: {
  busy: boolean;
  fix: LearnedFix;
  onSwitch: (status: "on" | "off") => void;
}) => {
  const t = useTranslations("dictation.learned");
  const label = t("fix", { from: fix.from, to: fix.to });
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <span className="min-w-0 flex-1 text-sm wrap-break-word">{label}</span>
      <Switch
        aria-label={label}
        checked={fix.status === "on"}
        disabled={busy}
        onCheckedChange={(checked) => {
          onSwitch(checked ? "on" : "off");
        }}
      />
    </li>
  );
};

const LearnedProblem = ({
  failed,
  stored,
}: {
  failed: boolean;
  stored: Stored;
}) => {
  const t = useTranslations("dictation.learned");
  if (stored.status === "unreadable") {
    return (
      <p className="text-destructive-foreground text-xs" role="alert">
        {t("unreadable")}
      </p>
    );
  }
  return failed ? (
    <p className="text-destructive-foreground text-xs" role="alert">
      {t("failed")}
    </p>
  ) : null;
};

const readLearned = async (): Promise<Stored> => {
  const result = await Result.tryPromise(async () =>
    invoke<unknown>("dictation_learned_get"),
  );
  return Result.isOk(result) && isLearnedView(result.value)
    ? { fixes: result.value.fixes, status: "read" }
    : { status: "unreadable" };
};

/** The learned fixes as this computer read them, or that it could not. */
type Stored =
  | { status: "reading" }
  | { fixes: LearnedFix[]; status: "read" }
  | { status: "unreadable" };

const reportFailure = () => {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
    window: DESKTOP_TELEMETRY_WINDOWS.main,
  });
};
