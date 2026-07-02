import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { invalidateMemories } from "@/routes/_protected.settings/-queries/memories";
import type { MemoryScope } from "@/routes/_protected.settings/-queries/memories";

type MemoryKind =
  | "preference"
  | "instruction"
  | "fact"
  | "decision"
  | "relationship";

type MemoryCreateFormProps =
  | { scope: "user"; workspaceId?: never }
  | { scope: "organization"; workspaceId?: never }
  | { scope: "workspace"; workspaceId: string };

const MEMORY_KIND_KEYS = {
  preference: "memory.kinds.preference",
  instruction: "memory.kinds.instruction",
  fact: "memory.kinds.fact",
  decision: "memory.kinds.decision",
  relationship: "memory.kinds.relationship",
} as const satisfies Record<MemoryKind, TranslationKey>;

// Matter-specific kinds may only live at workspace scope (DB CHECK),
// so user/firm creation is limited to the matter-agnostic kinds.
const KINDS_BY_SCOPE = {
  user: ["preference", "instruction"],
  organization: ["preference", "instruction"],
  workspace: ["preference", "instruction", "fact", "decision", "relationship"],
} as const satisfies Record<MemoryScope, readonly MemoryKind[]>;

export const MemoryCreateForm = (props: MemoryCreateFormProps) => {
  const { scope } = props;
  const t = useTranslations();
  const commonT = useTranslations("common");
  const tErrors = useTranslations("errors");
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const kinds = KINDS_BY_SCOPE[scope];
  const [kind, setKind] = useState<MemoryKind>(kinds[0]);
  const [content, setContent] = useState("");

  const createMemory = useMutation({
    mutationFn: async () => {
      const trimmed = content.trim();
      if (scope === "organization") {
        const response = await api.memories.firm.post({
          kind: kind === "preference" ? "preference" : "instruction",
          content: trimmed,
        });
        if (response.error) {
          throw toAPIError(response.error);
        }
        return response.data;
      }

      const response = await api.memories.post({
        scope,
        kind,
        content: trimmed,
        ...(props.scope === "workspace" && {
          workspaceId: toSafeId<"workspace">(props.workspaceId),
        }),
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      setContent("");
      setKind(kinds[0]);
      await invalidateMemories(queryClient, activeOrganizationId);
      stellaToast.add({ title: t("memory.createdToast"), type: "success" });
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({ title: tErrors("actionFailed"), type: "error" });
    },
  });

  const canSubmit = content.trim().length > 0 && !createMemory.isPending;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) {
          createMemory.mutate();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <Select
          onValueChange={(value) => {
            if (isMemoryKind(value)) {
              setKind(value);
            }
          }}
          value={kind}
        >
          <SelectTrigger className="w-44 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {kinds.map((option) => (
              <SelectItem key={option} value={option}>
                {t(MEMORY_KIND_KEYS[option])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Textarea
          onChange={(event) => setContent(event.target.value)}
          placeholder={t("memory.addPlaceholder")}
          size="sm"
          value={content}
        />
      </div>
      <Button
        className="self-start"
        disabled={!canSubmit}
        loading={createMemory.isPending}
        size="sm"
        type="submit"
      >
        {commonT("add")}
      </Button>
    </form>
  );
};

const isMemoryKind = (value: unknown): value is MemoryKind =>
  value === "preference" ||
  value === "instruction" ||
  value === "fact" ||
  value === "decision" ||
  value === "relationship";
