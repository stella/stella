import { useMemo, useState } from "react";

import { CheckIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { Separator } from "@stll/ui/components/separator";
import { cn } from "@stll/ui/lib/utils";

import { UserIdentity } from "@/components/user-avatar";
import { getDisplayName } from "@/routes/_protected.workspaces/-components/team-avatars";
import type {
  LeadFilter,
  Workspace,
} from "@/routes/_protected.workspaces/-types";

type TeamFilterPopoverProps = {
  teamValue: string[] | undefined;
  onTeamChange: (value: string[] | undefined) => void;
  leadValue: LeadFilter | undefined;
  onLeadChange: (value: LeadFilter | undefined) => void;
  workspaces: readonly Workspace[];
};

type MemberOption = {
  userId: string;
  userName: string;
  userImage: string | null;
};

export const TeamFilterPopover = ({
  teamValue,
  onTeamChange,
  leadValue,
  onLeadChange,
  workspaces,
}: TeamFilterPopoverProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");

  const members = useMemo<MemberOption[]>(() => {
    const map = new Map<string, MemberOption>();
    for (const w of workspaces) {
      for (const m of w.members) {
        if (!map.has(m.userId)) {
          map.set(m.userId, {
            userId: m.userId,
            userName: getDisplayName(m.userName, m.userId),
            userImage: m.userImage,
          });
        }
      }
    }
    return [...map.values()].sort((a, b) =>
      a.userName.localeCompare(b.userName),
    );
  }, [workspaces]);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? members.filter((m) => m.userName.toLowerCase().includes(q))
    : members;

  const selectedTeam: Set<string> = teamValue ? new Set(teamValue) : new Set();
  const toggleTeam = (id: string) => {
    const next = new Set(selectedTeam);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onTeamChange(next.size === 0 ? undefined : [...next]);
  };

  const isLeadAny = leadValue?.type === "any";
  const isLeadNone = leadValue?.type === "none";

  return (
    <div className="flex w-72 flex-col gap-2">
      <section className="flex flex-col gap-1">
        <p className="text-muted-foreground px-2 text-xs font-medium tracking-tight uppercase">
          {t("workspaces.filters.team.lead")}
        </p>
        <button
          className={cn(
            "hover:bg-accent flex items-center justify-between rounded px-2 py-1.5 text-sm",
          )}
          onClick={() => onLeadChange(isLeadAny ? undefined : { type: "any" })}
          type="button"
        >
          <span>{t("workspaces.filters.team.hasLead")}</span>
          {isLeadAny && <CheckIcon className="text-primary size-3.5" />}
        </button>
        <button
          className={cn(
            "hover:bg-accent flex items-center justify-between rounded px-2 py-1.5 text-sm",
          )}
          onClick={() =>
            onLeadChange(isLeadNone ? undefined : { type: "none" })
          }
          type="button"
        >
          <span>{t("workspaces.filters.team.noLead")}</span>
          {isLeadNone && <CheckIcon className="text-primary size-3.5" />}
        </button>
      </section>

      <Separator />

      <section className="flex flex-col gap-1">
        <p className="text-muted-foreground px-2 text-xs font-medium tracking-tight uppercase">
          {t("workspaces.filters.team.members")}
        </p>
        <Input
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("workspaces.filters.team.searchMembers")}
          size="sm"
          value={search}
        />
        <div className="max-h-56 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-sm">
              {t("workspaces.filters.noMatches")}
            </p>
          ) : (
            filtered.map((m) => {
              const active = selectedTeam.has(m.userId);
              const isLeadUser =
                leadValue?.type === "user" && leadValue.userId === m.userId;
              return (
                <div
                  className="hover:bg-accent flex items-center gap-2 rounded px-1 py-1"
                  key={m.userId}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2"
                    onClick={() => toggleTeam(m.userId)}
                    type="button"
                  >
                    <UserIdentity
                      avatarClassName="size-5 shrink-0 text-[0.5625rem]"
                      className="min-w-0 flex-1"
                      image={m.userImage}
                      name={m.userName}
                      nameClassName="text-sm"
                    />
                    {active && (
                      <CheckIcon className="text-primary size-3.5 shrink-0" />
                    )}
                  </button>
                  <button
                    className={cn(
                      "text-muted-foreground hover:text-foreground shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] tracking-tight uppercase",
                      isLeadUser && "text-primary",
                    )}
                    onClick={() =>
                      onLeadChange(
                        isLeadUser
                          ? undefined
                          : { type: "user", userId: m.userId },
                      )
                    }
                    title={t("workspaces.filters.team.filterAsLead")}
                    type="button"
                  >
                    {isLeadUser
                      ? t("workspaces.filters.team.leadActive")
                      : t("workspaces.filters.team.leadInactive")}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </section>

      {(teamValue !== undefined || leadValue !== undefined) && (
        <>
          <Separator />
          <Button
            onClick={() => {
              onTeamChange(undefined);
              onLeadChange(undefined);
            }}
            size="xs"
            variant="ghost"
          >
            <XIcon className="size-3.5" />
            {t("workspaces.filters.clear")}
          </Button>
        </>
      )}
    </div>
  );
};
