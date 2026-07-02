import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, PencilIcon, PinIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { invalidateMemories } from "@/routes/_protected.settings/-queries/memories";
import type { MemoryListItem } from "@/routes/_protected.settings/-queries/memories";

type MemoryRowProps = {
  activeOrganizationId: string;
  memory: MemoryListItem;
};

const MEMORY_KIND_KEYS = {
  preference: "memory.kinds.preference",
  instruction: "memory.kinds.instruction",
  fact: "memory.kinds.fact",
  decision: "memory.kinds.decision",
  relationship: "memory.kinds.relationship",
} as const satisfies Record<MemoryListItem["kind"], TranslationKey>;

const MEMORY_SOURCE_KEYS = {
  user: "memory.sources.user",
  tool: "memory.sources.tool",
  extracted: "memory.sources.extracted",
} as const satisfies Record<MemoryListItem["source"], TranslationKey>;

export const MemoryRow = ({ activeOrganizationId, memory }: MemoryRowProps) => {
  const t = useTranslations();
  const commonT = useTranslations("common");
  const tErrors = useTranslations("errors");
  const format = useFormatter();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);

  const updateMemory = useMutation({
    mutationFn: async (body: {
      content?: string;
      pinned?: boolean;
      status?: "active" | "archived";
    }) => {
      const response = await api
        .memories({ memoryId: toSafeId<"aiMemory">(memory.id) })
        .patch(body);

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onSuccess: async () => {
      await invalidateMemories(queryClient, activeOrganizationId);
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({ title: tErrors("actionFailed"), type: "error" });
    },
  });

  const saveEdit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      return;
    }
    updateMemory.mutate(
      { content: trimmed },
      { onSuccess: () => setIsEditing(false) },
    );
  };

  return (
    <div className="bg-card flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs font-medium">
          {t(MEMORY_KIND_KEYS[memory.kind])}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            aria-label={memory.pinned ? commonT("unpin") : commonT("pin")}
            disabled={updateMemory.isPending}
            onClick={() => updateMemory.mutate({ pinned: !memory.pinned })}
            size="icon-sm"
            variant="ghost"
          >
            <PinIcon
              className={cn("size-4", memory.pinned && "fill-current")}
            />
          </Button>
          <Button
            aria-label={commonT("edit")}
            disabled={updateMemory.isPending}
            onClick={() => {
              setDraft(memory.content);
              setIsEditing((prev) => !prev);
            }}
            size="icon-sm"
            variant="ghost"
          >
            <PencilIcon className="size-4" />
          </Button>
          <Button
            aria-label={commonT("archive")}
            disabled={updateMemory.isPending}
            onClick={() => updateMemory.mutate({ status: "archived" })}
            size="icon-sm"
            variant="ghost"
          >
            <ArchiveIcon className="size-4" />
          </Button>
        </div>
      </div>

      {isEditing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            onChange={(event) => setDraft(event.target.value)}
            size="sm"
            value={draft}
          />
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => setIsEditing(false)}
              size="sm"
              variant="ghost"
            >
              {commonT("cancel")}
            </Button>
            <Button
              disabled={draft.trim().length === 0}
              loading={updateMemory.isPending}
              onClick={saveEdit}
              size="sm"
            >
              {commonT("save")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm whitespace-pre-wrap">{memory.content}</p>
      )}

      <p className="text-muted-foreground text-xs">
        {t("memory.provenance", {
          source: t(MEMORY_SOURCE_KEYS[memory.source]),
          date: format.dateTime(new Date(memory.createdAt), {
            dateStyle: "medium",
          }),
        })}
      </p>
    </div>
  );
};
