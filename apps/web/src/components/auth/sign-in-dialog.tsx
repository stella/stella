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
    setStep({ status: "otp", email, devOtp: await fetchDevOtp(email) });
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
                void showOtpStep(email);
              }}
            />
          ) : (
            <OTPPanel
              email={step.email}
              initialOtp={step.devOtp ?? undefined}
              redirectTo={redirectTo}
              surface="bare"
              onUseDifferentEmail={() => {
                setStep({ status: "sign-in" });
              }}
              onVerified={async () => {
                await navigate({
                  to: "/auth/organization",
                  search: { redirectTo },
                  replace: true,
                });
              }}
            />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
