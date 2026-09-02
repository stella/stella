import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Field, FieldLabel } from "@stll/ui/field";
import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";

import { authClient } from "@/lib/auth";
import { sessionOptions } from "@/lib/auth-queries";
import { toAuthClientError } from "@/lib/errors/auth";

const PREFERRED_NAME_MAX_LENGTH = 120;

type AuthorNameRequiredDialogProps = {
  /** The name was saved; the caller retries the edit turn from here. */
  onNameSaved: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

/**
 * Prompts for a preferred name when the server-executed `suggest_changes`
 * variant returns `{success: false, code: "author_name_required"}` --
 * automatic DOCX edits
 * write tracked changes attributed to the acting user, so a name is
 * required before the tool can apply anything. Saves via the same
 * `authClient.updateUser({ preferredName })` mutation as the account
 * settings page, then hands control back so the caller can retry the turn.
 */
export const AuthorNameRequiredDialog = ({
  onNameSaved,
  onOpenChange,
  open,
}: AuthorNameRequiredDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [preferredName, setPreferredName] = useState("");
  const trimmedName = preferredName.trim();

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.updateUser({
        preferredName: trimmedName,
      });
      if (error) {
        throw toAuthClientError(error);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
      onNameSaved();
    },
    onError: () => {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
  });

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setPreferredName("");
        }
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t("chat.tool.suggestChangesAuthorNameDialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("chat.tool.suggestChangesAuthorNameDialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Field>
            <FieldLabel htmlFor="author-name-required-input">
              {t("settings.account.preferredName")}
            </FieldLabel>
            <Input
              autoFocus
              id="author-name-required-input"
              maxLength={PREFERRED_NAME_MAX_LENGTH}
              onChange={(event) => setPreferredName(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  trimmedName.length > 0 &&
                  !isPending
                ) {
                  mutate();
                }
              }}
              placeholder={t("settings.account.preferredNamePlaceholder")}
              disabled={isPending}
              value={preferredName}
            />
          </Field>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={trimmedName.length === 0 || isPending}
            loading={isPending}
            onClick={() => mutate()}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
