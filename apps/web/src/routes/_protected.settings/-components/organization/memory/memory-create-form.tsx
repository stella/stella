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

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
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
  preference: "kinds.preference",
  instruction: "kinds.instruction",
  fact: "kinds.fact",
  decision: "kinds.decision",
  relationship: "kinds.relationship",
} as const satisfies Record<MemoryKind, string>;

type MemoryToastKey = "createdToast" | "alreadyExistsToast" | "restoredToast";

// Matter-specific kinds may only live at workspace scope (DB CHECK),
// so user/firm creation is limited to the matter-agnostic kinds.
const KINDS_BY_SCOPE = {
  user: ["preference", "instruction"],
  organization: ["preference", "instruction"],
  workspace: ["preference", "instruction", "fact", "decision", "relationship"],
} as const satisfies Record<MemoryScope, readonly MemoryKind[]>;

export const MemoryCreateForm = (props: MemoryCreateFormProps) => {
  const { scope } = props;
  const t = useTranslations("memory");
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
    onSuccess: async (result) => {
      setContent("");
      setKind(kinds[0]);
      await invalidateMemories(queryClient, activeOrganizationId);
      let toastKey: MemoryToastKey = "createdToast";
      if (result.type === "existing") {
        toastKey = "alreadyExistsToast";
      }
      if (result.type === "reactivated") {
        toastKey = "restoredToast";
      }
      stellaToast.add({ title: t(toastKey), type: "success" });
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
          disabled={createMemory.isPending}
          onValueChange={(value) => {
            if (isMemoryKind(value)) {
              setKind(value);
            }
          }}
          value={kind}
        >
          <SelectTrigger aria-label={commonT("type")} className="w-44 shrink-0">
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
          aria-label={t("addPlaceholder")}
          disabled={createMemory.isPending}
          onChange={(event) => setContent(event.target.value)}
          placeholder={t("addPlaceholder")}
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
