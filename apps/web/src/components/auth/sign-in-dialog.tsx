import { useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";

import { OTPPanel } from "@/components/auth/otp-panel";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import { detached } from "@/lib/detached";
import { fetchDevOtp } from "@/lib/dev-otp";

type SignInDialogProps = {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  redirectTo: string;
};

type SignInDialogStep =
  | { status: "sign-in" }
  | { status: "otp"; email: string; devOtp: string | null };

export function SignInDialog({
  onOpenChange,
  open,
  redirectTo,
}: SignInDialogProps) {
  const t = useTranslations();
  const navigate = useNavigate();
  const [step, setStep] = useState<SignInDialogStep>({ status: "sign-in" });

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setStep({ status: "sign-in" });
    }
  };

  const showOtpStep = async (email: string) => {
    // Transition immediately; the dev OTP fills in once it arrives so a slow or
    // unreachable dev API never blocks the OTP screen. The panel is keyed by the
    // code, so it remounts and picks up the prefill when it lands.
    setStep({ status: "otp", email, devOtp: null });
    const devOtp = await fetchDevOtp(email);
    setStep((prev) =>
      prev.status === "otp" && prev.email === email
        ? { status: "otp", email, devOtp }
        : prev,
    );
  };

  const handleVerified = async () => {
    await navigate({
      to: "/auth/organization",
      search: { redirectTo },
      replace: true,
    });
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("auth.signIn")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {step.status === "sign-in" ? (
            <SignInPanel
              redirectTo={redirectTo}
              showHeading={false}
              onOtpSent={({ email }) => {
                detached(showOtpStep(email), "SignInDialog");
              }}
            />
          ) : (
            <OTPPanel
              key={step.devOtp ?? "empty"}
              email={step.email}
              initialOtp={step.devOtp ?? undefined}
              redirectTo={redirectTo}
              surface="bare"
              onUseDifferentEmail={() => {
                setStep({ status: "sign-in" });
              }}
              onVerified={handleVerified}
            />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
