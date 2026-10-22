import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ClipboardIcon, Clock3Icon, FileTextIcon } from "@stll/ui/icons";
import { Separator } from "@stll/ui/separator";

import { formatShortcut } from "../shared/shortcut-keys";
import {
  DESKTOP_PLATFORM,
  useClipboardShortcut,
  useKeyboardLayout,
} from "../shared/use-clipboard-shortcut";
import { FeatureRow } from "./FeatureRow";
import { reportOnboardingFailure } from "./onboarding-telemetry";
import type { StepProps } from "./step-props";
import { StepFooter } from "./StepFooter";

export const HowItWorksStep = ({ onBack, onContinue, snapshot }: StepProps) => {
  const t = useTranslations("onboarding");
  const locale = useLocale();
  const layout = useKeyboardLayout();
  const [shortcut] = useClipboardShortcut(reportOnboardingFailure);
  const staysLocal =
    DESKTOP_PLATFORM === "mac" ? t("staysLocalMac") : t("staysLocalPc");
  const app = snapshot.documentApp;

  return (
    <>
      <h1 className="text-xl font-semibold">{t("howTitle")}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{t("howBody")}</p>
      <div className="bg-card mt-5 overflow-hidden rounded-xl border">
        <FeatureRow
          description={t("howDocumentsBody")}
          icon={
            app?.iconDataUrl ? (
              <img alt="" className="size-8" src={app.iconDataUrl} />
            ) : (
              <FileTextIcon className="size-4" />
            )
          }
          title={
            app ? t("howDocumentsNamed", { app: app.name }) : t("howDocuments")
          }
        />
        <Separator />
        <FeatureRow
          badge={staysLocal}
          description={t("howClipboardBody", {
            shortcut: shortcut
              ? formatShortcut({
                  keys: shortcut.keys,
                  layout,
                  locale,
                  platform: DESKTOP_PLATFORM,
                })
              : "",
          })}
          icon={<ClipboardIcon className="size-4" />}
          title={t("howClipboard")}
        />
        {snapshot.activityAvailable ? (
          <>
            <Separator />
            <FeatureRow
              badge={staysLocal}
              description={t("howActivityBody")}
              icon={<Clock3Icon className="size-4" />}
              title={t("howActivity")}
            />
          </>
        ) : null}
      </div>
      <StepFooter
        onBack={onBack}
        primary={<Button onClick={onContinue}>{t("continue")}</Button>}
        snapshot={snapshot}
      />
    </>
  );
};
