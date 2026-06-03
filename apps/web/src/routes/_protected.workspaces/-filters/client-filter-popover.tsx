import { useMemo, useState } from "react";

import { CheckIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { Separator } from "@stll/ui/components/separator";
import { cn } from "@stll/ui/lib/utils";

import type { Workspace } from "@/routes/_protected.workspaces/-types";

type ClientFilterPopoverProps = {
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
  workspaces: readonly Workspace[];
};

export const ClientFilterPopover = ({
  value,
  onChange,
  workspaces,
}: ClientFilterPopoverProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");

  const clients = useMemo(() => {
    const map = new Map<string, { id: string; displayName: string }>();
    for (const w of workspaces) {
      if (w.client) {
        map.set(w.client.id, w.client);
      }
    }
    return [...map.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }, [workspaces]);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? clients.filter((c) => c.displayName.toLowerCase().includes(q))
    : clients;

  const selected: Set<string> = value ? new Set(value) : new Set();
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(next.size === 0 ? undefined : [...next]);
  };

  return (
    <div className="flex w-64 flex-col gap-1">
      <Input
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("workspaces.filters.searchClients")}
        size="sm"
        value={search}
      />
      <div className="max-h-64 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-sm">
            {t("workspaces.filters.noMatches")}
          </p>
        ) : (
          filtered.map((c) => {
            const active = selected.has(c.id);
            return (
              <button
                className={cn(
                  "hover:bg-accent flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-sm",
                )}
                key={c.id}
                onClick={() => toggle(c.id)}
                type="button"
              >
                <span className="truncate">{c.displayName}</span>
                {active && (
                  <CheckIcon className="text-primary size-3.5 shrink-0" />
                )}
              </button>
            );
          })
        )}
      </div>
      {value && value.length > 0 && (
        <>
          <Separator className="my-1" />
          <Button onClick={() => onChange(undefined)} size="xs" variant="ghost">
            <XIcon className="size-3.5" />
            {t("workspaces.filters.clear")}
          </Button>
        </>
      )}
    </div>
  );
};
