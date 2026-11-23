import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  nextCleanupPart,
  parseCleanedMarkdown,
} from "@stll/transcript/cleanup";
import type { CleanedBlock, CleanedRun } from "@stll/transcript/cleanup";
import { Button } from "@stll/ui/button";
import { CopyButton } from "@stll/ui/copy-button";
import { ChevronDownIcon, InfoIcon } from "@stll/ui/icons";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { Skeleton } from "@stll/ui/skeleton";

import type { Paragraph } from "./transcribe-logic";

/** The longest part one cleanup request carries, in characters; the API
 *  contract's recording cleanup limit. */
const MAX_PART_CHARACTERS = 12_000;

type CleanedPart = { instructions: string[]; markdown: string };

type PartState = {
  from: number;
  to: number;
  text: string;
  status: "running" | "done" | "failed";
  result: CleanedPart | null;
};

type RecordingCleanup = {
  parts: readonly PartState[];
  instructions: string[];
  markdown: string;
  running: boolean;
  /** Each part's blocks, read separately so a list in one part never
   *  continues another's numbering. */
  blocks: CleanedBlock[];
  /** A part is being cleaned up; Try again waits for it. */
  busy: boolean;
  failed: number;
  retry: (index: number) => void;
  /** Whether cleanup runs: on its own, or once the speaker asked. */
  started: boolean;
  start: () => void;
};

const isCleanedPart = (value: unknown): value is CleanedPart =>
  typeof value === "object" &&
  value !== null &&
  "markdown" in value &&
  typeof value.markdown === "string" &&
  "instructions" in value &&
  Array.isArray(value.instructions) &&
  value.instructions.every((line: unknown) => typeof line === "string");

const requestCleanup = async (
  job: number,
  transcript: string,
  previousText: string | null,
): Promise<CleanedPart | null> => {
  const result = await Result.tryPromise(async () =>
    invoke<unknown>("transcribe_clean_up", {
      request: { job, transcript, previousText },
    }),
  );
  // An answer with neither text nor instructions lost the part: it is
  // shown as transcribed, with Try again.
  return Result.isOk(result) &&
    isCleanedPart(result.value) &&
    (result.value.markdown.trim() !== "" ||
      result.value.instructions.length > 0)
    ? result.value
    : null;
};

/**
 * Cleans up a recording's transcript part by part (the screen that uses it
 * is keyed by the job, so a new recording starts afresh), in order, as soon as
 * each part is transcribed: the window shows cleaned text while the rest
 * is still being transcribed. Each part goes with the cleaned text before
 * it, so sentences and lists continue. A part that fails is shown as
 * transcribed and can be tried again.
 */
export const useRecordingCleanup = ({
  job,
  paragraphs,
  finished,
  autoStart,
}: {
  job: number;
  paragraphs: readonly Paragraph[];
  finished: boolean;
  autoStart: boolean;
}): RecordingCleanup => {
  const [parts, setParts] = useState<PartState[]>([]);
  const [started, setStarted] = useState(autoStart);
  const sending = useRef<string | null>(null);

  const run = useCallback(
    async (
      index: number,
      part: Pick<PartState, "text">,
      previous: string | null,
    ) => {
      const answer = await requestCleanup(job, part.text, previous);
      setParts((current) =>
        current.map((entry, at) =>
          at === index
            ? {
                ...entry,
                status: answer === null ? "failed" : "done",
                result: answer,
              }
            : entry,
        ),
      );
    },
    [job],
  );

  useEffect(() => {
    if (!started || parts.some((part) => part.status === "running")) {
      return;
    }
    const last = parts.at(-1);
    const part = nextCleanupPart({
      paragraphs,
      from: last?.to ?? 0,
      finished,
      first: parts.length === 0,
      maxCharacters: MAX_PART_CHARACTERS,
    });
    if (part === null) {
      return;
    }
    const key = `${job}:${part.from}`;
    if (sending.current === key) {
      return;
    }
    sending.current = key;
    const index = parts.length;
    const previous = previousMarkdown(parts, index);
    setParts((current) => [
      ...current,
      { ...part, status: "running", result: null },
    ]);
    void run(index, part, previous);
  }, [finished, job, paragraphs, parts, run, started]);

  const retry = useCallback(
    (index: number) => {
      const part = parts[index];
      // One request at a time: a retry waits until the running part ends.
      if (
        part?.status !== "failed" ||
        parts.some((entry) => entry.status === "running")
      ) {
        return;
      }
      setParts((current) =>
        current.map((entry, at) =>
          at === index ? { ...entry, status: "running" } : entry,
        ),
      );
      void run(index, part, previousMarkdown(parts, index));
    },
    [parts, run],
  );

  const done = parts.flatMap((part) =>
    part.result === null ? [] : [part.result],
  );
  return {
    parts,
    instructions: [...new Set(done.flatMap((part) => part.instructions))],
    markdown: parts
      .map((part) => part.result?.markdown ?? part.text)
      .join("\n\n"),
    running:
      started &&
      (parts.some((part) => part.status === "running") ||
        !finished ||
        nextCleanupPart({
          paragraphs,
          from: parts.at(-1)?.to ?? 0,
          finished,
          first: parts.length === 0,
          maxCharacters: MAX_PART_CHARACTERS,
        }) !== null),
    blocks: parts.flatMap((part) =>
      part.result === null
        ? part.text.split("\n\n").map((text) => ({
            kind: "paragraph" as const,
            inline: [{ text, bold: false, italic: false }],
          }))
        : parseCleanedMarkdown(part.result.markdown),
    ),
    busy: parts.some((part) => part.status === "running"),
    failed: parts.filter((part) => part.status === "failed").length,
    retry,
    started,
    start: () => setStarted(true),
  };
};

/** The cleaned text before part `index`, for the next part to continue. */
const previousMarkdown = (
  parts: readonly PartState[],
  index: number,
): string | null => parts[index - 1]?.result?.markdown ?? null;

const InlineRuns = ({ inline }: { inline: readonly CleanedRun[] }) =>
  inline.map((run, index) => {
    const key = `${index}:${run.text.length}`;
    const text = run.italic ? <em>{run.text}</em> : run.text;
    return run.bold ? (
      <strong className="font-semibold" key={key}>
        {text}
      </strong>
    ) : (
      <Fragment key={key}>{text}</Fragment>
    );
  });

/** The window's own title is h1 and each pane's is h2, so the cleaned
 *  text's headings start at h3. */
const HEADING_TAGS = { 1: "h3", 2: "h4", 3: "h5" } as const;

const HEADING_CLASSES = {
  1: "mt-2 text-lg font-semibold",
  2: "mt-2 text-base font-semibold",
  3: "mt-1 text-sm font-semibold",
} as const;

const CleanedBlocks = ({ blocks }: { blocks: readonly CleanedBlock[] }) =>
  blocks.map((block, index) => {
    const key = `${block.kind}:${index}`;
    switch (block.kind) {
      case "heading": {
        const Heading = HEADING_TAGS[block.level];
        return (
          <Heading className={HEADING_CLASSES[block.level]} key={key}>
            <InlineRuns inline={block.inline} />
          </Heading>
        );
      }
      case "paragraph":
        return (
          <p className="text-sm leading-relaxed text-pretty" key={key}>
            <InlineRuns inline={block.inline} />
          </p>
        );
      case "list": {
        const List = block.ordered ? "ol" : "ul";
        return (
          <List
            {...(block.ordered && block.start !== 1
              ? { start: block.start }
              : {})}
            className={
              block.ordered
                ? "flex list-decimal flex-col gap-0.5 ps-5 text-sm leading-relaxed"
                : "flex list-disc flex-col gap-0.5 ps-5 text-sm leading-relaxed"
            }
            key={key}
          >
            {block.items.map((item, at) => {
              const itemKey = `${at}:${item.map((run) => run.text).join("")}`;
              return (
                <li key={itemKey}>
                  <InlineRuns inline={item} />
                </li>
              );
            })}
          </List>
        );
      }
      default:
        return null;
    }
  });

const Pending = () => (
  <div aria-hidden="true" className="flex flex-col gap-2 pt-1">
    <Skeleton className="h-2.5 w-11/12 rounded-full" />
    <Skeleton className="h-2.5 w-4/5 rounded-full" />
    <Skeleton className="h-2.5 w-1/2 rounded-full" />
  </div>
);

/** The cleaned-up text: the dictation's instructions apart, then each part
 *  as formatted text, as transcribed where cleanup failed, or pending. */
export const CleanedText = ({
  cleanup,
  transcribing,
}: {
  cleanup: RecordingCleanup;
  transcribing: boolean;
}) => {
  const t = useTranslations("transcribe.cleaned");
  const tRoot = useTranslations("transcribe");
  const { parts, instructions } = cleanup;
  return (
    <div className="flex max-w-xl flex-col gap-3">
      {instructions.length > 0 ? (
        <div className="border-border flex flex-col gap-1 rounded-lg border border-dashed px-3 py-2.5">
          <p className="text-muted-foreground text-2xs font-semibold tracking-wide uppercase">
            {t("instructionsTitle")}
          </p>
          {instructions.map((line) => (
            <p
              className="text-foreground-strong-muted text-sm text-pretty"
              key={line}
            >
              {line}
            </p>
          ))}
        </div>
      ) : null}
      {parts.map((part, index) => {
        const key = `${part.from}:${part.to}`;
        if (part.status === "running") {
          return <Pending key={key} />;
        }
        if (part.status === "failed" || part.result === null) {
          return (
            <div
              className="bg-muted flex flex-col gap-2 rounded-lg px-3 py-2.5"
              key={key}
            >
              <div className="text-muted-foreground flex items-start gap-1.5 text-xs">
                <InfoIcon
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0"
                />
                <p className="flex-1 text-pretty">{t("partFailed")}</p>
                <Button
                  disabled={cleanup.busy}
                  disabledReason={t("running")}
                  onClick={() => cleanup.retry(index)}
                  size="xs"
                  variant="ghost"
                >
                  {tRoot("retry")}
                </Button>
              </div>
              <p className="text-foreground-strong-muted text-sm leading-relaxed text-pretty whitespace-pre-line">
                {part.text}
              </p>
            </div>
          );
        }
        return (
          <Fragment key={key}>
            <CleanedBlocks
              blocks={parseCleanedMarkdown(part.result.markdown)}
            />
          </Fragment>
        );
      })}
      {transcribing && !parts.some((part) => part.status === "running") ? (
        <>
          <Pending />
          <p className="text-muted-foreground text-xs">{t("waiting")}</p>
        </>
      ) : null}
    </div>
  );
};

/** A recording transcribed on this computer with AI cleanup off: its text
 *  goes to the organization's AI model only when the speaker asks. */
export const CleanupOffer = ({ onStart }: { onStart: () => void }) => {
  const t = useTranslations("transcribe.cleaned");
  return (
    <div className="flex max-w-md flex-col items-start gap-3 pt-2">
      <p className="text-sm font-semibold">{t("offerTitle")}</p>
      <p className="text-muted-foreground text-xs text-pretty">
        {t("offerDescription")}
      </p>
      <Button onClick={onStart} size="sm" variant="outline">
        {t("offerStart")}
      </Button>
    </div>
  );
};

type CopyFormat = "formatted" | "plain";

const COPY_FORMAT_KEY = "stella.transcribe.copyFormat";

/** Stores the copy format; without storage the choice lasts only while
 *  the window is open. */
const rememberCopyFormat = (next: CopyFormat): boolean =>
  Result.isOk(
    Result.try(() => {
      localStorage.setItem(COPY_FORMAT_KEY, next);
    }),
  );

/** The copy format the user chose last; formatted by default. */
export const useCopyFormat = (): [CopyFormat, (next: CopyFormat) => void] => {
  const [format, setFormat] = useState<CopyFormat>(() => {
    // Storage can be unavailable; formatted is then the choice.
    const stored = Result.try(() => localStorage.getItem(COPY_FORMAT_KEY));
    return Result.isOk(stored) && stored.value === "plain"
      ? "plain"
      : "formatted";
  });
  const choose = useCallback((next: CopyFormat) => {
    setFormat(next);
    rememberCopyFormat(next);
  }, []);
  return [format, choose];
};

type SaveOption = { id: string; label: string; onSave: () => void };

/** Copy (in the remembered format, with a menu to change it) and Save as,
 *  for one pane. */
export const PaneActions = ({
  disabledReason,
  copyFormat,
  onCopyFormatChange,
  onCopy,
  saveOptions,
}: {
  disabledReason: string | undefined;
  copyFormat: CopyFormat;
  onCopyFormatChange: (next: CopyFormat) => void;
  onCopy: (format: CopyFormat) => Promise<boolean>;
  saveOptions: readonly SaveOption[];
}) => {
  const t = useTranslations("transcribe");
  const disabled = disabledReason !== undefined;
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center">
        <CopyButton
          copiedLabel={t("result.copied")}
          disabled={disabled}
          disabledReason={disabledReason}
          label={t("result.copy")}
          onCopy={async () => await onCopy(copyFormat)}
          size="xs"
          variant="ghost"
        />
        <Menu>
          <MenuTrigger
            aria-label={t("copyMenu.label")}
            disabled={disabled}
            render={
              <Button
                disabledReason={disabledReason}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <ChevronDownIcon
              aria-hidden="true"
              className="text-muted-foreground"
            />
          </MenuTrigger>
          <MenuPopup align="end" className="w-60">
            <MenuRadioGroup value={copyFormat}>
              <MenuRadioItem
                closeOnClick
                onClick={() => onCopyFormatChange("formatted")}
                value="formatted"
              >
                {t("copyMenu.formatted")}
              </MenuRadioItem>
              <MenuRadioItem
                closeOnClick
                onClick={() => onCopyFormatChange("plain")}
                value="plain"
              >
                {t("copyMenu.plain")}
              </MenuRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
            <p className="text-muted-foreground px-2 py-1 text-xs text-pretty">
              {t("copyMenu.hint")}
            </p>
          </MenuPopup>
        </Menu>
      </div>
      <Menu>
        <MenuTrigger
          disabled={disabled}
          render={
            <Button
              disabledReason={disabledReason}
              size="xs"
              variant="outline"
            />
          }
        >
          {t("result.saveAs")}
          <ChevronDownIcon
            aria-hidden="true"
            className="text-muted-foreground"
          />
        </MenuTrigger>
        <MenuPopup align="end" className="w-64">
          {saveOptions.map((option) => (
            <MenuItem key={option.id} onClick={option.onSave}>
              {option.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
};
