import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { detached } from "@/lib/detached";
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
  const [latestServerNotes, setLatestServerNotes] = useState(
    contact.notes ?? "",
  );
  const skipNextSaveRef = useRef(false);

  // Reconcile the server notes prop into the local draft during render
  // (React's sanctioned "adjust state when a prop changes" pattern, tracking the
  // last-seen server value in state). When the server value changes, accept it
  // only if the user hasn't diverged from the value the server last gave us;
  // otherwise keep the in-progress edit.
  const nextServerNotes = contact.notes ?? "";
  if (nextServerNotes !== latestServerNotes) {
    if (draft === latestServerNotes) {
      setDraft(nextServerNotes);
    }
    setLatestServerNotes(nextServerNotes);
  }

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
          detached(
            invalidateContactCaches(queryClient, {
              activeOrganizationId,
              contactId: contact.id,
            }),
            "onSuccess",
          );
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
