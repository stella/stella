import { useState } from "react";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import { Label } from "@stll/ui/components/label";
import { Textarea } from "@stll/ui/components/textarea";
import { MessageSquarePlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar";
import { useAnalytics } from "@/lib/analytics/provider";

export const FeedbackDialog = () => {
  const t = useTranslations();
  const analytics = useAnalytics();

  const [open, setOpen] = useState(false);
  const [issueDescription, setIssueDescription] = useState("");
  const [suggestedFix, setSuggestedFix] = useState("");

  const reset = () => {
    setIssueDescription("");
    setSuggestedFix("");
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      reset();
    }
    setOpen(nextOpen);
  };

  const handleSubmit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!issueDescription.trim()) {
      return;
    }

    analytics.capture("feedback_submitted", {
      description: issueDescription.trim(),
      suggested_fix: suggestedFix.trim() || undefined,
      route: window.location.pathname,
    });

    setOpen(false);
    reset();
  };

  return (
    <SidebarMenuItem>
      <Dialog onOpenChange={handleOpenChange} open={open}>
        <DialogTrigger
          render={
            <SidebarMenuButton size="sm" tooltip={t("feedback.trigger")} />
          }
        >
          <MessageSquarePlusIcon className="size-4" />
          <span>{t("feedback.trigger")}</span>
        </DialogTrigger>
        <DialogPopup className="max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{t("feedback.title")}</DialogTitle>
              <DialogDescription>{t("feedback.description")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 px-6 pb-4">
              <div className="flex flex-col gap-1.5">
                <Label>{t("feedback.describeIssue")}</Label>
                <Textarea
                  autoFocus
                  onChange={(e) => setIssueDescription(e.target.value)}
                  placeholder={t("feedback.describeIssuePlaceholder")}
                  required
                  size="sm"
                  value={issueDescription}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t("feedback.suggestedFix")}</Label>
                <Textarea
                  onChange={(e) => setSuggestedFix(e.target.value)}
                  placeholder={t("feedback.suggestedFixPlaceholder")}
                  size="sm"
                  value={suggestedFix}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => handleOpenChange(false)}
                type="button"
                variant="outline"
              >
                {t("common.cancel")}
              </Button>
              <Button disabled={!issueDescription.trim()} type="submit">
                {t("feedback.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </SidebarMenuItem>
  );
};
