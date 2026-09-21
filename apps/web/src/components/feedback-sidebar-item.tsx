import { lazy, Suspense, useState } from "react";

import { MegaphoneIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar";
import { useAnalytics } from "@/lib/analytics/provider";

// Lazy so the form stack stays out of the shell bundle until someone reports
// something.
const FeedbackDialog = lazy(async () => {
  const module = await import("@/components/feedback-dialog");
  return { default: module.FeedbackDialog };
});

const DIALOG_STATES = {
  idle: "idle",
  open: "open",
  closed: "closed",
} as const;

type DialogState = (typeof DIALOG_STATES)[keyof typeof DIALOG_STATES];

/** Sidebar entry point. Owns its own dialog so the shell stays a layout. */
export const FeedbackSidebarItem = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  // `idle` until first opened, so the chunk is never fetched for a session
  // that files nothing; `closed` keeps it mounted for the exit transition.
  const [dialogState, setDialogState] = useState<DialogState>(
    DIALOG_STATES.idle,
  );

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => {
          analytics.captureFeedbackDialogOpened({ source: "sidebar" });
          setDialogState(DIALOG_STATES.open);
        }}
        size="sm"
        tooltip={t("feedback.trigger")}
      >
        <MegaphoneIcon className="size-4" />
        <span>{t("feedback.trigger")}</span>
      </SidebarMenuButton>
      {dialogState !== DIALOG_STATES.idle && (
        <Suspense fallback={null}>
          <FeedbackDialog
            onOpenChange={(open) =>
              setDialogState(open ? DIALOG_STATES.open : DIALOG_STATES.closed)
            }
            open={dialogState === DIALOG_STATES.open}
            source="sidebar"
          />
        </Suspense>
      )}
    </SidebarMenuItem>
  );
};
