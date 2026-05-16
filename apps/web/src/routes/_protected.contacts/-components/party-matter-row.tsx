import { Link } from "@tanstack/react-router";
import { LayersIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { resolveMatterColor } from "@/lib/matter-colors";
import type { PartyMatter } from "@/routes/_protected.contacts/-components/types";
import {
  PARTY_ROLE_LABEL_KEYS,
  toPartyRole,
} from "@/routes/_protected.workspaces/$workspaceId/-party-roles";

export const PartyMatterRow = ({ matter }: { matter: PartyMatter }) => {
  const t = useTranslations();

  return (
    <Link
      className="hover:bg-muted flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors"
      params={{ workspaceId: matter.id }}
      to="/workspaces/$workspaceId"
    >
      <MatterIcon matter={matter} />
      <span className="font-medium">{matter.name}</span>
      <div className="ms-auto flex flex-wrap justify-end gap-1">
        {matter.roles.map((role) => {
          const parsedRole = toPartyRole(role);
          const roleKey = parsedRole
            ? PARTY_ROLE_LABEL_KEYS[parsedRole]
            : PARTY_ROLE_LABEL_KEYS.other;

          return (
            <span
              className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs"
              key={role}
            >
              {t(roleKey)}
            </span>
          );
        })}
      </div>
    </Link>
  );
};

export const MatterIcon = ({
  matter,
}: {
  matter: { id: string; color: string | null };
}) => {
  const activeColor = resolveMatterColor(matter.id, matter.color);

  return (
    <LayersIcon className="size-4 shrink-0" style={{ color: activeColor }} />
  );
};
