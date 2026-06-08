import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
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

type WorkflowStartConfirmationInput = {
  entityCount: number;
};

type WorkflowStartConfirmationPrompt = (
  input: WorkflowStartConfirmationInput,
) => Promise<boolean>;

type PendingPrompt = WorkflowStartConfirmationInput & {
  resolve: (confirmed: boolean) => void;
};

const defaultPrompt: WorkflowStartConfirmationPrompt = async () =>
  await Promise.resolve(false);

const WorkflowStartConfirmationPromptContext =
  createContext<WorkflowStartConfirmationPrompt>(defaultPrompt);

export const WorkflowStartConfirmationPromptProvider = ({
  children,
}: PropsWithChildren) => {
  const t = useTranslations();
  const pendingPromptRef = useRef<PendingPrompt | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(
    null,
  );

  const settlePrompt = useCallback((confirmed: boolean) => {
    const prompt = pendingPromptRef.current;
    pendingPromptRef.current = null;
    setPendingPrompt(null);
    prompt?.resolve(confirmed);
  }, []);

  const confirmLargeRun = useCallback<WorkflowStartConfirmationPrompt>(
    async (input) => {
      pendingPromptRef.current?.resolve(false);

      return await new Promise((resolve) => {
        const nextPrompt = { ...input, resolve };
        pendingPromptRef.current = nextPrompt;
        setPendingPrompt(nextPrompt);
      });
    },
    [],
  );

  useEffect(
    () => () => {
      const prompt = pendingPromptRef.current;
      pendingPromptRef.current = null;
      prompt?.resolve(false);
    },
    [],
  );

  return (
    <WorkflowStartConfirmationPromptContext.Provider value={confirmLargeRun}>
      {children}
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            settlePrompt(false);
          }
        }}
        open={pendingPrompt !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workspaces.workflow.largeRunPrompt.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspaces.workflow.largeRunPrompt.description", {
                count: String(pendingPrompt?.entityCount ?? 0),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button onClick={() => settlePrompt(false)} variant="ghost">
              {t("common.cancel")}
            </Button>
            <Button onClick={() => settlePrompt(true)}>
              {t("workspaces.workflow.largeRunPrompt.start")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </WorkflowStartConfirmationPromptContext.Provider>
  );
};

export const useWorkflowStartConfirmationPrompt = () =>
  useContext(WorkflowStartConfirmationPromptContext);
