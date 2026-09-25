// Passive regression fixture for
// `no-custom-account-modal/no-custom-account-modal`.
//
// A module that draws a modal and hands the reader to the sign-in dialog is a
// second account prompt in front of the canonical one. If the detector
// regresses, the disable directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
// oxlint-disable-next-line no-custom-account-modal/no-custom-account-modal -- a modal that asks for an account
import { Dialog, DialogPopup, DialogTitle } from "@stll/ui/dialog";

import { usePublicSignInRequest } from "@/components/public-sign-in-request";

export const CustomAccountModalFixture = ({ href }: { href: string }) => {
  const t = useTranslations();
  const requestSignIn = usePublicSignInRequest();

  return (
    <Dialog open>
      <DialogPopup>
        <DialogTitle>{t("auth.createFreeAccount")}</DialogTitle>
        <Button
          onClick={() => {
            requestSignIn?.(href);
          }}
        >
          {t("auth.createFreeAccount")}
        </Button>
      </DialogPopup>
    </Dialog>
  );
};
