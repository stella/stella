import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { ContactPicker } from "@/components/contact-picker";
import { SelectedClient } from "@/components/workspaces/create-matter-dialog";
import { MatterCombobox } from "@/components/workspaces/matter-combobox";
import type { MatterOption } from "@/components/workspaces/matter-combobox";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { contactOptions } from "@/lib/contacts/queries";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import type { MatterDraftClient } from "@/lib/workspaces/create-matter-store";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

import { skillAvailabilityOptions } from "./skill-availability.logic";
import type { SkillAvailability, SkillScope } from "./skill-availability.logic";

type SkillAvailabilityFieldProps = {
  availability: SkillAvailability;
  canManageTeam: boolean;
  client: MatterDraftClient | null;
  matter: MatterOption | null;
  onAvailabilityChange: (next: SkillAvailability) => void;
  onClientChange: (next: MatterDraftClient | null) => void;
  onMatterChange: (next: MatterOption | null) => void;
  scope: SkillScope;
};

/**
 * Where a new skill can be used: everywhere its scope reaches, one matter, or
 * one client's matters (admins and owners only). Fixed once the skill exists.
 */
export const SkillAvailabilityField = ({
  availability,
  canManageTeam,
  client,
  matter,
  onAvailabilityChange,
  onClientChange,
  onMatterChange,
  scope,
}: SkillAvailabilityFieldProps) => {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const options = skillAvailabilityOptions({ canManageTeam, scope });
  const optionLabel = (option: SkillAvailability) => {
    switch (option) {
      case "everywhere":
        return scope === "team"
          ? tSkills("availabilityOrganization")
          : t("knowledge.skills.form.scopePrivate");
      case "matter":
        return tSkills("availabilityMatter");
      case "client":
        return tSkills("availabilityClient");
      default:
        option satisfies never;
        return panic(`Unhandled skill availability: ${String(option)}`);
    }
  };
  const help = (() => {
    switch (availability) {
      case "everywhere":
        return null;
      case "matter":
        return canManageTeam || scope === "private"
          ? tSkills("availabilityMatterHelp")
          : tSkills("availabilityTeamNeedsMatter");
      case "client":
        return tSkills("availabilityClientHelp");
      default:
        availability satisfies never;
        return panic(`Unhandled skill availability: ${String(availability)}`);
    }
  })();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-2">
        <label
          className="text-muted-foreground text-xs"
          htmlFor="skill-availability"
        >
          {tSkills("availabilityLabel")}
        </label>
        <Select
          disabled={options.length < 2}
          onValueChange={(value) => {
            const next = options.find((option) => option === value);
            if (next !== undefined) {
              onAvailabilityChange(next);
            }
          }}
          value={availability}
        >
          <SelectTrigger className="w-44" id="skill-availability">
            <SelectValue>{optionLabel(availability)}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {optionLabel(option)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {availability === "matter" && (
        <MatterCombobox
          activeOrganizationId={activeOrganizationId}
          id="skill-availability-matter"
          onChange={onMatterChange}
          userId={userId}
          value={matter}
        />
      )}
      {availability === "client" && (
        <div className="flex flex-col gap-2">
          {client && (
            <SelectedClient
              clearLabel={t("workspaces.parties.removeClient")}
              client={client}
              onClear={() => onClientChange(null)}
            />
          )}
          <ContactPicker
            onSelect={(contact) =>
              onClientChange({
                displayName: contact.displayName,
                id: contact.id,
                type: contact.type,
              })
            }
            placeholder={
              client
                ? t("workspaces.parties.changeClient")
                : t("workspaces.parties.searchContacts")
            }
          />
        </div>
      )}
      {help !== null && <p className="text-muted-foreground text-xs">{help}</p>}
    </div>
  );
};

type SkillAvailabilitySummaryProps = {
  boundClientId: string | null;
  boundWorkspaceId: string | null;
  scope: SkillScope;
};

/**
 * Where an existing skill can be used, read-only: the binding is fixed at
 * creation. Names the matter from the navigation list the sidebar already
 * holds and the client from its contact record; while either is unknown it
 * falls back to "One matter" / "One client". A label/value pair for the
 * editor's metadata grid.
 */
export const SkillAvailabilitySummary = ({
  boundClientId,
  boundWorkspaceId,
  scope,
}: SkillAvailabilitySummaryProps) => {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  // Names are a nicety: a failed read falls back to the generic label and is
  // reported, never blocking the editor.
  const navigationView = useQueryView(
    useQuery({
      ...workspacesNavigationOptions({
        organizationId: activeOrganizationId,
        userId,
      }),
      enabled: boundWorkspaceId !== null,
    }),
  );
  useQueryViewError(navigationView);
  const clientView = useQueryView(
    useQuery({
      ...contactOptions(activeOrganizationId, boundClientId ?? ""),
      enabled: boundClientId !== null,
    }),
  );
  useQueryViewError(clientView);
  const matterName =
    navigationView.type === "items"
      ? (navigationView.items.workspaces.find(
          (workspace) => workspace.id === boundWorkspaceId,
        )?.name ?? null)
      : null;
  const clientName =
    clientView.type === "items" ? clientView.items.displayName : null;
  const label = (() => {
    if (boundWorkspaceId !== null) {
      return matterName ?? tSkills("availabilityMatter");
    }
    if (boundClientId !== null) {
      return clientName ?? tSkills("availabilityClient");
    }
    return scope === "team"
      ? tSkills("availabilityOrganization")
      : t("knowledge.skills.form.scopePrivate");
  })();

  return (
    <>
      <span className="text-muted-foreground pt-0.5 text-xs">
        {tSkills("availabilityLabel")}
      </span>
      <div className="flex flex-col gap-1">
        <BidiText as="span" className="text-sm">
          {label}
        </BidiText>
        <p className="text-muted-foreground text-xs">
          {tSkills("availabilityFixedHelp")}
        </p>
      </div>
    </>
  );
};
