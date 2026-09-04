import { useDeferredValue, useMemo, useState } from "react";

import { panic } from "better-result";
import {
  ArrowRightIcon,
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FilePlusIcon,
  LoaderIcon,
  SearchIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { contentDir } from "@stll/ui/use-content-dir";
import { cn } from "@stll/ui/utils";

import { useChatMatters } from "@/components/chat/chat-matters-context";
import { assistantMessageFallbackText } from "@/components/chat/chat-thread-messages.logic";
import type {
  ChatUITools,
  RegisteredChatUIToolCallPart,
} from "@/components/chat/chat-ui-tools";
import {
  buildCreateDocumentDownloadFileName,
  normalizeCreateDocumentInput,
} from "@/components/chat/create-document-draft.logic";
import { DocumentIcon } from "@/components/document-icon";
import { MarkdownPreview } from "@/components/markdown-preview";
import { MatterIcon } from "@/components/matter-icon";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";

type CreateDocumentPart = Extract<
  RegisteredChatUIToolCallPart,
  { name: "create-document" }
>;
type CreateDocumentInput = ChatUITools["create-document"]["input"];
type CreateDocumentOutput = ChatUITools["create-document"]["output"];
type CreateDocumentSuccess = Extract<CreateDocumentOutput, { success: true }>;
type CreateDocumentMatterSuccess = Extract<
  CreateDocumentSuccess,
  { entityId: string }
>;

export type CreateDocumentDestination =
  | { type: "matter"; matterId: string }
  | { type: "download" };

export type NeedsMatterMatter = {
  id: string;
  name: string;
  color: string | null;
  client: { displayName: string } | null;
};

type NeedsMatterCardProps = {
  part: CreateDocumentPart;
  onResolve: (
    toolCallId: string,
    destination: CreateDocumentDestination,
    input: CreateDocumentInput,
  ) => Promise<void> | void;
  onOpenCreated: (output: CreateDocumentMatterSuccess) => Promise<void> | void;
  onOpenDraft?: ((toolCallId: string) => void) | undefined;
};

const isCreateDocumentToolFailureState = (
  part: CreateDocumentPart,
): boolean => {
  switch (part.state) {
    case "error":
    case "approval-requested":
    case "approval-responded":
      return true;
    case "awaiting-input":
    case "input-streaming":
    case "input-complete":
    case "complete":
      return false;
    default:
      part.state satisfies never;
      return panic(`Unhandled state: ${String(part.state)}`);
  }
};

export const NeedsMatterCard = ({
  part,
  onResolve,
  onOpenCreated,
  onOpenDraft,
}: NeedsMatterCardProps) => {
  const {
    createDocumentMatters: matters,
    isLoadingCreateDocumentMatters: isLoadingMatters,
  } = useChatMatters();
  const t = useTranslations();

  if (isCreateDocumentToolFailureState(part)) {
    return (
      <CreatedFailureCard message={t("chat.createDocument.failedHeader")} />
    );
  }

  // Streaming-tolerant input read. The runtime exposes the canonical parsed
  // input on the part; show whatever has arrived so far.
  const partialInput =
    part.state === "input-streaming" ||
    part.state === "input-complete" ||
    part.state === "complete"
      ? normalizeCreateDocumentInput(part.input)
      : null;
  const name = partialInput?.name ?? "";
  const sourcePreview = partialInput?.source ?? "";

  const isStreaming = part.state === "input-streaming";
  const completedOutput = part.state === "complete" ? part.output : undefined;
  const readyDraftOutput =
    completedOutput?.success === true &&
    "destination" in completedOutput &&
    completedOutput.destination === "draft"
      ? completedOutput
      : null;
  // Destination actions mutate an already completed draft. Waiting for the
  // draft settlement makes a second TanStack `addToolResult` structurally
  // impossible and avoids racing the automatic draft completion.
  const isAwaitingMatter = readyDraftOutput !== null;
  const successfulOutput =
    completedOutput?.success === true && readyDraftOutput === null
      ? completedOutput
      : null;
  const failedOutput =
    completedOutput?.success === false ? completedOutput : null;

  if (successfulOutput) {
    return (
      <CreatedSuccessCard onOpen={onOpenCreated} output={successfulOutput} />
    );
  }

  if (failedOutput) {
    return <CreatedFailureCard message={failedOutput.message} />;
  }

  const handleMatterContinue = async (matterId: string) => {
    if (!partialInput?.source) {
      return;
    }
    const fullInput: CreateDocumentInput = {
      name: partialInput.name ?? "Untitled",
      source: partialInput.source,
    };
    await onResolve(part.id, { type: "matter", matterId }, fullInput);
  };

  const handleDownload = async () => {
    if (!partialInput?.source) {
      return;
    }
    const fullInput: CreateDocumentInput = {
      name: partialInput.name ?? "Untitled",
      source: partialInput.source,
    };
    await onResolve(part.id, { type: "download" }, fullInput);
  };

  return (
    <div className="border-border bg-muted/30 my-1 rounded-lg border text-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <FilePlusIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="font-medium">
          {isStreaming
            ? t("chat.createDocument.headerStreaming")
            : t("chat.createDocument.headerReady")}
        </span>
        {isAwaitingMatter && onOpenDraft !== undefined && (
          <Button
            className="ms-auto"
            onClick={() => onOpenDraft(part.id)}
            size="xs"
            variant="ghost"
          >
            {t("chat.createDocument.openInFolio")}
          </Button>
        )}
        {isStreaming && (
          <LoaderIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 animate-spin" />
        )}
      </div>

      <DocumentPreview name={name} source={sourcePreview} />

      {isAwaitingMatter && (
        <MatterPickerSection
          isLoadingMatters={isLoadingMatters}
          matters={matters}
          onDownload={handleDownload}
          onContinue={handleMatterContinue}
        />
      )}
    </div>
  );
};

type DocumentPreviewProps = {
  name: string;
  source: string;
};

const DocumentPreview = ({ name, source }: DocumentPreviewProps) => {
  const t = useTranslations();
  const snippet = useMemo(() => extractPreviewSnippet(source), [source]);
  const fileName = name ? buildCreateDocumentDownloadFileName(name) : "";

  if (!name && !snippet) {
    return null;
  }

  return (
    <div className="border-border/50 flex gap-3 border-t px-3 py-3">
      <DocumentThumbnail />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {fileName && (
          <p className="truncate text-xs font-semibold" dir="auto">
            {fileName}
          </p>
        )}
        {snippet ? (
          <MarkdownPreview
            className="text-muted-foreground max-h-15 overflow-hidden text-xs leading-5 wrap-break-word [&_h1]:mb-0 [&_h1]:text-xs [&_h2]:mb-0 [&_h2]:text-xs [&_h3]:mb-0 [&_h3]:text-xs [&_p]:my-0"
            fallbackChildren={assistantMessageFallbackText(snippet)}
          >
            {snippet}
          </MarkdownPreview>
        ) : (
          <p className="text-muted-foreground text-xs italic">
            {t("chat.createDocument.previewWaiting")}
          </p>
        )}
      </div>
    </div>
  );
};

const DocumentThumbnail = () => (
  <div className="bg-background border-border/60 flex h-16 w-12 shrink-0 items-center justify-center rounded border shadow-sm">
    <DocumentIcon
      className="size-9"
      fileName="document.docx"
      mimeType={DOCX_MIME}
    />
  </div>
);

// Strip the source `@`-directives (`@title`, `@clause`, etc.)
// so the preview shows readable text instead of compiler input.
const extractPreviewSnippet = (source: string): string => {
  if (!source) {
    return "";
  }
  const trimmed = source.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed.split(/\r?\n/u);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("@doc")) {
      continue;
    }
    if (line.startsWith("@")) {
      const stripped = line.replace(/^@\w+\s*/u, "").trim();
      if (stripped) {
        out.push(stripped);
      }
      continue;
    }
    out.push(line);
    if (out.join(" ").length > 360) {
      break;
    }
  }
  return out.join("\n").slice(0, 480);
};

type MatterPickerSectionProps = {
  matters: readonly NeedsMatterMatter[];
  isLoadingMatters: boolean;
  onContinue: (matterId: string) => Promise<void> | void;
  onDownload: () => Promise<void> | void;
};

const MatterPickerSection = ({
  matters,
  isLoadingMatters,
  onContinue,
  onDownload,
}: MatterPickerSectionProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [selectedMatterId, setSelectedMatterId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    if (q.length === 0) {
      return matters;
    }
    return matters.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.client?.displayName ?? "").toLowerCase().includes(q),
    );
  }, [matters, deferredSearch]);

  const handleContinue = async () => {
    if (!selectedMatterId || isSubmitting || isDownloading) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onContinue(selectedMatterId);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDownload = async () => {
    if (isSubmitting || isDownloading) {
      return;
    }
    setIsDownloading(true);
    try {
      await onDownload();
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <>
      <div className="border-border/50 space-y-2 border-t px-3 py-3">
        <p className="text-xs">{t("chat.createDocument.pickMatterPrompt")}</p>

        <div className="border-input focus-within:border-ring focus-within:ring-ring/16 bg-background flex items-center gap-1.5 rounded-md border px-1.5 transition-shadow focus-within:ring-2">
          <SearchIcon
            aria-hidden="true"
            className="text-muted-foreground size-3.5 shrink-0"
          />
          <input
            className="placeholder:text-foreground-placeholder h-7 w-full min-w-0 bg-transparent text-xs outline-none"
            dir={contentDir(search)}
            disabled={isSubmitting || isDownloading}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("inspector.matterPicker.searchPlaceholder")}
            type="text"
            value={search}
          />
        </div>

        {(() => {
          if (isLoadingMatters) {
            return (
              <p className="text-muted-foreground py-2 text-center text-xs">
                {t("common.loading")}
              </p>
            );
          }
          if (matters.length === 0) {
            return (
              <p className="text-muted-foreground py-2 text-center text-xs">
                {t("inspector.matterPicker.empty")}
              </p>
            );
          }
          if (filtered.length === 0) {
            return (
              <p className="text-muted-foreground py-2 text-center text-xs">
                {t("inspector.matterPicker.noResults", {
                  query: search,
                })}
              </p>
            );
          }
          return (
            <div className="max-h-56 overflow-y-auto rounded-md border">
              {filtered.map((m) => {
                const isSelected = m.id === selectedMatterId;
                return (
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 px-2 py-1.5 text-start text-xs transition-colors",
                      isSelected
                        ? "bg-foreground text-background"
                        : "hover:bg-muted",
                    )}
                    disabled={isSubmitting || isDownloading}
                    key={m.id}
                    onClick={() => setSelectedMatterId(m.id)}
                    type="button"
                  >
                    <MatterIcon
                      className="size-3.5 shrink-0"
                      matter={{ id: m.id, color: m.color }}
                    />
                    <BidiText as="span" className="min-w-0 flex-1 truncate">
                      {m.name}
                    </BidiText>
                    {m.client?.displayName && (
                      <BidiText
                        as="span"
                        className={cn(
                          "shrink-0 text-[10px]",
                          isSelected ? "opacity-80" : "text-muted-foreground",
                        )}
                      >
                        {m.client.displayName}
                      </BidiText>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })()}
      </div>

      <div className="border-border/50 flex items-center justify-end gap-2 border-t px-3 py-2">
        <Button
          disabled={isSubmitting || isDownloading}
          onClick={() => {
            detached(handleDownload(), "needs-matter-card.download");
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          <DownloadIcon className="size-3.5" />
          {isDownloading ? t("common.loading") : t("common.download")}
        </Button>
        <Button
          disabled={selectedMatterId === null || isSubmitting || isDownloading}
          onClick={() => {
            detached(handleContinue(), "needs-matter-card.continue");
          }}
          size="sm"
          type="button"
        >
          {isSubmitting
            ? t("common.loading")
            : t("chat.createDocument.continue")}
        </Button>
      </div>
    </>
  );
};

type CreatedSuccessCardProps = {
  output: CreateDocumentSuccess;
  onOpen: (output: CreateDocumentMatterSuccess) => Promise<void> | void;
};

const CreatedSuccessCard = ({ output, onOpen }: CreatedSuccessCardProps) => {
  const t = useTranslations();
  const matterOutput = "entityId" in output ? output : null;
  const canOpen =
    matterOutput !== null &&
    Boolean(matterOutput.entityId) &&
    Boolean(matterOutput.workspaceId);

  const body = (
    <>
      <DocumentThumbnail />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <BidiText as="span" className="truncate text-xs font-semibold">
          {output.fileName}
        </BidiText>
        {canOpen && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
            {t("chat.createDocument.openInFolio")}
            <DirectionalIcon
              className="size-3 shrink-0"
              icon={ArrowRightIcon}
            />
          </span>
        )}
      </div>
      {canOpen && (
        <ExternalLinkIcon className="text-muted-foreground size-3.5 shrink-0" />
      )}
    </>
  );

  return (
    <div className="border-border bg-muted/40 my-1 rounded-lg border text-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <FilePlusIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="font-medium">{t("chat.createDocument.created")}</span>
        <CheckIcon className="text-success ms-auto size-3.5 shrink-0" />
      </div>
      {canOpen ? (
        <button
          className={cn(
            "border-border/50 hover:bg-muted/60 flex w-full items-center gap-3 border-t px-3 py-3 text-start transition-colors",
          )}
          onClick={() => {
            detached(onOpen(matterOutput), "needs-matter-card.open");
          }}
          type="button"
        >
          {body}
        </button>
      ) : (
        <div className="border-border/50 flex w-full items-center gap-3 border-t px-3 py-3 text-start">
          {body}
        </div>
      )}
    </div>
  );
};

const CreatedFailureCard = ({ message }: { message: string }) => {
  const t = useTranslations();
  return (
    <div className="border-border bg-muted/30 my-1 rounded-lg border text-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <FilePlusIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="font-medium">
          {t("chat.createDocument.failedHeader")}
        </span>
      </div>
      <p className="border-border/50 text-muted-foreground border-t px-3 py-3 text-xs">
        {message}
      </p>
    </div>
  );
};
