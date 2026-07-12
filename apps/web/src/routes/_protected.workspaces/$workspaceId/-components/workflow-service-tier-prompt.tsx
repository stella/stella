import { createContext, use, useRef, useState } from "react";
import type { PropsWithChildren } from "react";

import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";

import { useMountEffect } from "@/hooks/use-effect";

type WorkflowServiceTier = "standard" | "flex";

type WorkflowServiceTierPromptInput = {
  entityCount: number;
};

type WorkflowServiceTierPrompt = (
  input: WorkflowServiceTierPromptInput,
) => Promise<WorkflowServiceTier>;

type PendingPrompt = WorkflowServiceTierPromptInput & {
  resolve: (serviceTier: WorkflowServiceTier) => void;
};

const defaultPrompt: WorkflowServiceTierPrompt = async () =>
  await Promise.resolve("standard");

const WorkflowServiceTierPromptContext =
  createContext<WorkflowServiceTierPrompt>(defaultPrompt);

export const WorkflowServiceTierPromptProvider = ({
  children,
}: PropsWithChildren) => {
  const t = useTranslations();
  const pendingPromptRef = useRef<PendingPrompt | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(
    null,
  );

  const settlePrompt = (serviceTier: WorkflowServiceTier) => {
    const prompt = pendingPromptRef.current;
    pendingPromptRef.current = null;
    setPendingPrompt(null);
    prompt?.resolve(serviceTier);
  };

  const askServiceTier: WorkflowServiceTierPrompt = async (input) => {
    pendingPromptRef.current?.resolve("standard");

    return await new Promise((resolve) => {
      const nextPrompt = { ...input, resolve };
      pendingPromptRef.current = nextPrompt;
      setPendingPrompt(nextPrompt);
    });
  };

  useMountEffect(() => () => {
    const prompt = pendingPromptRef.current;
    pendingPromptRef.current = null;
    prompt?.resolve("standard");
  });

  return (
    <WorkflowServiceTierPromptContext.Provider value={askServiceTier}>
      {children}
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            settlePrompt("standard");
          }
        }}
        open={pendingPrompt !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workspaces.workflow.serviceTierPrompt.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspaces.workflow.serviceTierPrompt.description", {
                count: String(pendingPrompt?.entityCount ?? 0),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button onClick={() => settlePrompt("standard")} variant="outline">
              {t("workspaces.workflow.serviceTierPrompt.standard")}
            </Button>
            <Button onClick={() => settlePrompt("flex")}>
              {t("workspaces.workflow.serviceTierPrompt.flex")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </WorkflowServiceTierPromptContext.Provider>
  );
};

export const useWorkflowServiceTierPrompt = () =>
  use(WorkflowServiceTierPromptContext);
