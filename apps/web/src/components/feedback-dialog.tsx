import { useCallback, useRef, useState } from "react";
import { CameraIcon, LoaderIcon, MessageSquarePlusIcon } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Checkbox } from "@stella/ui/components/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stella/ui/components/dialog";
import { Label } from "@stella/ui/components/label";
import { Textarea } from "@stella/ui/components/textarea";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar";
import { captureError } from "@/lib/posthog/utils";

/** Cap screenshot dimensions so base64 stays under PostHog's 1 MB event limit. */
const MAX_SCREENSHOT_SIDE = 1280;

export const FeedbackDialog = () => {
  const t = useTranslations();
  const posthog = usePostHog();

  const [open, setOpen] = useState(false);
  const [issueDescription, setIssueDescription] = useState("");
  const [suggestedFix, setSuggestedFix] = useState("");
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [screenshotFailed, setScreenshotFailed] = useState(false);
  const screenshotRef = useRef<string | null>(null);

  const captureScreenshot = useCallback(async () => {
    const { default: html2canvas } = await import("html2canvas-pro");
    const ratio = Math.min(
      MAX_SCREENSHOT_SIDE / window.innerWidth,
      MAX_SCREENSHOT_SIDE / window.innerHeight,
      1,
    );
    const canvas = await html2canvas(document.body, {
      scale: window.devicePixelRatio * 0.5 * ratio,
      logging: false,
      useCORS: true,
      removeContainer: true,
    });
    return canvas.toDataURL("image/webp", 0.7);
  }, []);

  const reset = useCallback(() => {
    setIssueDescription("");
    setSuggestedFix("");
    setIncludeScreenshot(false);
    setScreenshotFailed(false);
    screenshotRef.current = null;
  }, []);

  const handleOpen = useCallback(
    async (nextOpen: boolean) => {
      if (nextOpen) {
        setCapturing(true);
        setScreenshotFailed(false);
        try {
          screenshotRef.current = await captureScreenshot();
          setIncludeScreenshot(true);
        } catch (error) {
          captureError(
            posthog,
            error instanceof Error ? error : new Error(String(error)),
          );
          screenshotRef.current = null;
          setScreenshotFailed(true);
        }
        setCapturing(false);
      } else {
        reset();
      }
      setOpen(nextOpen);
    },
    [captureScreenshot, posthog, reset],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!issueDescription.trim()) {
      return;
    }

    posthog.capture("feedback_submitted", {
      description: issueDescription.trim(),
      suggested_fix: suggestedFix.trim() || undefined,
      route: window.location.pathname,
      ...(includeScreenshot &&
        screenshotRef.current && {
          screenshot: screenshotRef.current,
        }),
    });

    setOpen(false);
    reset();
  };

  return (
    <SidebarMenuItem>
      <Dialog onOpenChange={handleOpen} open={open}>
        <DialogTrigger
          render={<SidebarMenuButton disabled={capturing} size="sm" />}
        >
          {capturing ? (
            <LoaderIcon className="size-4 animate-spin" />
          ) : (
            <MessageSquarePlusIcon className="size-4" />
          )}
          {t("feedback.trigger")}
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
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={includeScreenshot}
                    disabled={!screenshotRef.current}
                    id="feedback-screenshot"
                    onCheckedChange={(val) =>
                      setIncludeScreenshot(val === true)
                    }
                  />
                  <Label className="font-normal" htmlFor="feedback-screenshot">
                    <CameraIcon className="size-3.5 text-muted-foreground" />
                    {t("feedback.includeScreenshot")}
                  </Label>
                </div>
                {!screenshotFailed && (
                  <p className="text-xs text-muted-foreground">
                    {t("feedback.screenshotHint")}
                  </p>
                )}
                {screenshotFailed && (
                  <span className="text-xs text-destructive">
                    {t("feedback.screenshotFailed")}
                  </span>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => handleOpen(false)}
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
