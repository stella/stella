import { Fragment } from "react";

import { panic } from "better-result";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  ClipboardIcon,
  Clock3Icon,
  DictateIcon,
  FileTextIcon,
  SignatureIcon,
} from "@stll/ui/icons";
import { Separator } from "@stll/ui/separator";

import { DESKTOP_FEATURES } from "../shared/desktop-features";
import type { DesktopFeature } from "../shared/desktop-features";
import { formatShortcut } from "../shared/shortcut-keys";
import {
  DESKTOP_PLATFORM,
  useClipboardShortcut,
  useKeyboardLayout,
} from "../shared/use-clipboard-shortcut";
import { FeatureRow } from "./FeatureRow";
import { reportOnboardingFailure } from "./onboarding-telemetry";
import type { OnboardingSnapshot } from "./onboarding-types";
import type { StepProps } from "./step-props";
import { StepFooter } from "./StepFooter";

/** What the app does, one row per feature in the order every surface
 *  lists the features in. */
export const HowItWorksStep = ({ onBack, onContinue, snapshot }: StepProps) => {
  const t = useTranslations("onboarding");
  const locale = useLocale();
  const layout = useKeyboardLayout();
  const [shortcut] = useClipboardShortcut(reportOnboardingFailure);
  const clipboardShortcut = shortcut
    ? formatShortcut({
        keys: shortcut.keys,
        layout,
        locale,
        platform: DESKTOP_PLATFORM,
      })
    : "";
  const shown = DESKTOP_FEATURES.filter((feature) =>
    offered(feature, snapshot),
  );

  return (
    <>
      <h1 className="text-xl font-semibold">{t("howTitle")}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{t("howBody")}</p>
      <div className="bg-card mt-5 overflow-hidden rounded-xl border">
        {shown.map((feature, index) => (
          <Fragment key={feature}>
            {index === 0 ? null : <Separator />}
            <HowItWorksRow
              clipboardShortcut={clipboardShortcut}
              documentApp={snapshot.documentApp}
              feature={feature}
            />
          </Fragment>
        ))}
      </div>
      <StepFooter
        onBack={onBack}
        primary={<Button onClick={onContinue}>{t("continue")}</Button>}
        snapshot={snapshot}
      />
    </>
  );
};

const offered = (
  feature: DesktopFeature,
  snapshot: OnboardingSnapshot,
): boolean => {
  switch (feature) {
    case "documents":
    case "clipboard":
    case "signing":
      return true;
    case "dictation":
      return snapshot.dictationAvailable;
    case "activity":
      return snapshot.activityAvailable;
    default:
      feature satisfies never;
      return panic("Unknown desktop feature.");
  }
};

const HowItWorksRow = ({
  clipboardShortcut,
  documentApp: app,
  feature,
}: {
  /** The clipboard history shortcut as this keyboard writes it. */
  clipboardShortcut: string;
  documentApp: OnboardingSnapshot["documentApp"];
  feature: DesktopFeature;
}) => {
  const t = useTranslations("onboarding");
  const staysLocal =
    DESKTOP_PLATFORM === "mac" ? t("staysLocalMac") : t("staysLocalPc");

  switch (feature) {
    case "documents":
      return (
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
      );
    case "clipboard":
      return (
        <FeatureRow
          badge={staysLocal}
          description={t("howClipboardBody", { shortcut: clipboardShortcut })}
          icon={<ClipboardIcon className="size-4" />}
          title={t("howClipboard")}
        />
      );
    case "signing":
      return (
        <FeatureRow
          description={
            DESKTOP_PLATFORM === "mac"
              ? t("howSigningBodyMac")
              : t("howSigningBodyPc")
          }
          icon={<SignatureIcon className="size-4" />}
          title={t("howSigning")}
        />
      );
    case "dictation":
      return (
        <FeatureRow
          description={t("howDictationBody")}
          icon={<DictateIcon className="size-4" />}
          title={t("howDictation")}
        />
      );
    case "activity":
      return (
        <FeatureRow
          badge={staysLocal}
          description={t("howActivityBody")}
          icon={<Clock3Icon className="size-4" />}
          title={t("howActivity")}
        />
      );
    default:
      feature satisfies never;
      return panic("Unknown desktop feature.");
  }
};
