import { useEffect, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { invalidateContactCaches } from "@/routes/_protected.contacts/-components/contact-caches";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";
import { useUpdateContact } from "@/routes/_protected.contacts/-mutations";

const protectedRouteApi = getRouteApi("/_protected");

export const ContactNotesEditor = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [draft, setDraft] = useState(contact.notes ?? "");
  const latestServerNotesRef = useRef(contact.notes ?? "");
  const skipNextSaveRef = useRef(false);

  useEffect(() => {
    const nextNotes = contact.notes ?? "";
    setDraft((currentDraft) =>
      currentDraft === latestServerNotesRef.current ? nextNotes : currentDraft,
    );
    latestServerNotesRef.current = nextNotes;
  }, [contact.notes]);

  const handleSave = () => {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    const current = contact.notes ?? "";
    if (draft === current) {
      return;
    }

    updateContact.mutate(
      {
        contactId: contact.id,
        notes: draft.trim().length === 0 ? null : draft,
      },
      {
        onSuccess: () => {
          void invalidateContactCaches(queryClient, {
            activeOrganizationId,
            contactId: contact.id,
          });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
          setDraft(current);
        },
      },
    );
  };

  return (
    <Textarea
      aria-label={t("common.notes")}
      className="min-h-28"
      disabled={updateContact.isPending}
      onBlur={handleSave}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          skipNextSaveRef.current = true;
          setDraft(contact.notes ?? "");
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      placeholder="—"
      value={draft}
    />
  );
};
