import { useState } from "react";

import { useNavigate } from "@tanstack/react-router";
import { PasswordResponses } from "pdfjs-dist";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stella/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@stella/ui/components/field";
import { Input } from "@stella/ui/components/input";

import { usePdfStore } from "@/lib/pdf/pdf-store";

export const PdfPasswordDialog = () => {
  const t = useTranslations();
  const passwordRequest = usePdfStore((s) => s.passwordRequest);
  const submitPassword = usePdfStore((s) => s.submitPassword);
  const cancelPassword = usePdfStore((s) => s.cancelPassword);
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/pdf",
  });
  const [password, setPassword] = useState("");

  const isIncorrect =
    passwordRequest?.reason === PasswordResponses.INCORRECT_PASSWORD;

  return (
    <Dialog
      // eslint-disable-next-line typescript/no-misused-promises
      onOpenChange={async (open) => {
        if (!open) {
          cancelPassword();
          await navigate({ to: "/workspaces/$workspaceId" });
        }
      }}
      open={passwordRequest !== null}
    >
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("workspaces.pdf.passwordRequired")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <Field>
            <FieldLabel>{t("workspaces.pdf.passwordLabel")}</FieldLabel>
            <Input
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              value={password}
            />
            {isIncorrect && (
              <FieldError match>
                {t("workspaces.pdf.incorrectPassword")}
              </FieldError>
            )}
          </Field>
        </DialogPanel>
        <DialogFooter>
          <DialogClose
            // eslint-disable-next-line typescript/no-misused-promises
            onClick={async () => {
              cancelPassword();
              await navigate({ to: "/workspaces/$workspaceId" });
            }}
            render={<Button variant="ghost" />}
          >
            {t("common.cancel")}
          </DialogClose>
          <Button
            onClick={() => {
              if (password) {
                submitPassword(password);
              }
            }}
          >
            {t("workspaces.pdf.unlock")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
