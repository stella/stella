import { useDeferredValue, useMemo, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";
import type { ToolUIPart } from "ai";
import {
  ArrowRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  FilePlusIcon,
  LayersIcon,
  LoaderIcon,
  SearchIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { ChatUITools } from "@/components/chat/chat-ui-tools";
import { resolveMatterColor } from "@/lib/matter-colors";

type CreateDocumentPart = ToolUIPart<Pick<ChatUITools, "create-document">>;
type CreateDocumentInput = ChatUITools["create-document"]["input"];
type CreateDocumentOutput = ChatUITools["create-document"]["output"];
type CreateDocumentSuccess = Extract<CreateDocumentOutput, { success: true }>;

export type NeedsMatterMatter = {
  id: string;
  name: string;
  color: string | null;
  client: { displayName: string } | null;
};

type NeedsMatterCardProps = {
  part: CreateDocumentPart;
  matters: readonly NeedsMatterMatter[];
  isLoadingMatters: boolean;
  onResolve: (
    toolCallId: string,
    matterId: string,
    input: CreateDocumentInput,
  ) => Promise<void> | void;
  onOpenCreated: (output: CreateDocumentSuccess) => Promise<void> | void;
};

export const NeedsMatterCard = ({
  part,
  matters,
  isLoadingMatters,
  onResolve,
  onOpenCreated,
}: NeedsMatterCardProps) => {
  const t = useTranslations();

  // Streaming-tolerant input read. While the AI is producing the
  // tool call, AI SDK populates `part.input` as a DeepPartial; show
  // whatever has arrived so far.
  const partialInput =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    part.state === "output-available"
      ? (part.input as Partial<CreateDocumentInput> | undefined)
      : undefined;
  const name = partialInput?.name ?? "";
  const sourcePreview = partialInput?.source ?? partialInput?.markdown ?? "";

  const isStreaming = part.state === "input-streaming";
  const isAwaitingMatter = part.state === "input-available";
  const successfulOutput =
    part.state === "output-available" && part.output.success
      ? part.output
      : null;
  const failedOutput =
    part.state === "output-available" && !part.output.success
      ? part.output
      : null;

  if (successfulOutput) {
    return (
      <CreatedSuccessCard onOpen={onOpenCreated} output={successfulOutput} />
    );
  }

  if (failedOutput) {
    return <CreatedFailureCard message={failedOutput.message} />;
  }

  return (
    <div className="border-border bg-muted/30 my-1 rounded-lg border text-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <FilePlusIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="font-medium">
          {isStreaming
            ? t("chat.createDocument.headerStreaming")
            : t("chat.createDocument.headerReady")}
        </span>
        {isStreaming && (
          <LoaderIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 animate-spin" />
        )}
      </div>

      <DocumentPreview name={name} source={sourcePreview} />

      {isAwaitingMatter && (
        <MatterPickerSection
          isLoadingMatters={isLoadingMatters}
          matters={matters}
          onContinue={async (matterId) => {
            if (!partialInput) {
              return;
            }
            const fullInput: CreateDocumentInput = {
              name: partialInput.name ?? "Untitled",
              ...(partialInput.source !== undefined && {
                source: partialInput.source,
              }),
              ...(partialInput.markdown !== undefined && {
                markdown: partialInput.markdown,
              }),
            };
            await onResolve(part.toolCallId, matterId, fullInput);
          }}
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

  if (!name && !snippet) {
    return null;
  }

  return (
    <div className="border-border/50 flex gap-3 border-t px-3 py-3">
      <DocumentThumbnail />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {name && (
          <p className="truncate text-xs font-semibold tracking-wide uppercase">
            {name}
          </p>
        )}
        {snippet ? (
          <p className="text-muted-foreground line-clamp-3 text-xs break-words whitespace-pre-wrap">
            {snippet}
          </p>
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
  <div className="bg-background border-border/60 flex h-16 w-12 shrink-0 flex-col gap-0.5 rounded border p-1.5 shadow-sm">
    <div className="bg-foreground-muted h-1 rounded" />
    <div className="bg-foreground-placeholder h-0.5 rounded" />
    <div className="bg-foreground-placeholder h-0.5 rounded" />
    <div className="bg-foreground-placeholder h-0.5 w-3/4 rounded" />
    <div className="bg-foreground-disabled mt-auto h-0.5 rounded" />
    <div className="bg-foreground-disabled h-0.5 w-1/2 rounded" />
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
  const lines = trimmed.split(/\r?\n/);
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
      const stripped = line.replace(/^@\w+\s*/, "").trim();
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
};

const MatterPickerSection = ({
  matters,
  isLoadingMatters,
  onContinue,
}: MatterPickerSectionProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [selectedMatterId, setSelectedMatterId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
    if (!selectedMatterId || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onContinue(selectedMatterId);
    } finally {
      setIsSubmitting(false);
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
            disabled={isSubmitting}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("inspector.matterPicker.searchPlaceholder")}
            type="text"
            value={search}
          />
        </div>

        {isLoadingMatters ? (
          <p className="text-muted-foreground py-2 text-center text-xs">
            {t("common.loading")}
          </p>
        ) : matters.length === 0 ? (
          <p className="text-muted-foreground py-2 text-center text-xs">
            {t("inspector.matterPicker.empty")}
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground py-2 text-center text-xs">
            {t("inspector.matterPicker.noResults", { query: search })}
          </p>
        ) : (
          <div className="max-h-56 overflow-y-auto rounded-md border">
            {filtered.map((m) => {
              const isSelected = m.id === selectedMatterId;
              const swatch = resolveMatterColor(m.id, m.color);
              return (
                <button
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1.5 text-start text-xs transition-colors",
                    isSelected
                      ? "bg-foreground text-background"
                      : "hover:bg-muted",
                  )}
                  disabled={isSubmitting}
                  key={m.id}
                  onClick={() => setSelectedMatterId(m.id)}
                  type="button"
                >
                  <LayersIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0"
                    style={{ color: isSelected ? undefined : swatch }}
                  />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  {m.client?.displayName && (
                    <span
                      className={cn(
                        "shrink-0 text-[10px]",
                        isSelected ? "opacity-80" : "text-muted-foreground",
                      )}
                    >
                      {m.client.displayName}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-border/50 flex items-center justify-end gap-2 border-t px-3 py-2">
        <Button
          disabled={selectedMatterId === null || isSubmitting}
          onClick={() => {
            void handleContinue();
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
  onOpen: (output: CreateDocumentSuccess) => Promise<void> | void;
};

const CreatedSuccessCard = ({ output, onOpen }: CreatedSuccessCardProps) => {
  const t = useTranslations();
  const canOpen = Boolean(output.entityId) && Boolean(output.workspaceId);

  const body = (
    <>
      <DocumentThumbnail />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs font-semibold">
          {output.fileName}
        </span>
        {canOpen && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
            {t("chat.createDocument.openInFolio")}
            <ArrowRightIcon className="size-3 shrink-0" />
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
        <CheckIcon className="ms-auto size-3.5 shrink-0 text-green-600 dark:text-green-400" />
      </div>
      {canOpen ? (
        <button
          className={cn(
            "border-border/50 hover:bg-muted/60 flex w-full items-center gap-3 border-t px-3 py-3 text-start transition-colors",
          )}
          onClick={() => {
            void onOpen(output);
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
