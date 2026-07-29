import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { LoaderIcon, SearchIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";

const MAX_SELECTED_SKILLS = 20;

type SkillScope = "team" | "private";

type DiscoveredSkill = {
  compatibility: string | null;
  description: string;
  integrity:
    | { type: "content-hash"; value: string }
    | { type: "github-commit"; value: string };
  license: string | null;
  name: string;
  path: string | null;
  sourceUrl: string;
  version: string | null;
};

type SkillDiscovery = {
  commitSha: string | null;
  invalidSkillCount: number;
  repositoryUrl: string | null;
  skills: DiscoveredSkill[];
};

type ImportSkillDialogProps = {
  canManageTeam: boolean;
  onImported: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

export const ImportSkillDialog = (props: ImportSkillDialogProps) => (
  <Dialog onOpenChange={props.onOpenChange} open={props.open}>
    {props.open ? <ImportSkillDialogBody {...props} /> : null}
  </Dialog>
);

const ImportSkillDialogBody = ({
  canManageTeam,
  onImported,
  onOpenChange,
}: ImportSkillDialogProps) => {
  const t = useTranslations();
  const tSkills = useTranslations("knowledge.agentSkills");
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<SkillScope>("private");
  const [discovery, setDiscovery] = useState<SkillDiscovery | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const discover = useMutation({
    mutationFn: async () => {
      const response = await api.skills["discover-url"].post({
        url: url.trim(),
      });
      return unwrapEden(response);
    },
    onSuccess: (result) => {
      setDiscovery(result);
      setSelected(
        new Set(
          result.skills
            .slice(0, MAX_SELECTED_SKILLS)
            .map((skill) => skill.sourceUrl),
        ),
      );
    },
    onError: (error) => {
      stellaToast.add({
        title: userErrorFromThrown(error, t("common.unexpectedError")),
        type: "error",
      });
    },
  });

  const importSkills = useMutation({
    mutationFn: async () => {
      const response = await api.skills["import-urls"].post({
        items:
          discovery?.skills
            .filter((skill) => selected.has(skill.sourceUrl))
            .map((skill) => ({
              integrity: skill.integrity,
              sourceUrl: skill.sourceUrl,
            })) ?? [],
        queryKey: ["skills"],
        scope,
      });
      return unwrapEden(response);
    },
    onSuccess: (result) => {
      if (result.installed.length > 0) {
        onImported();
      }
      if (result.failed.length === 0) {
        stellaToast.add({
          title: tSkills("importedSkills", {
            count: result.installed.length,
          }),
          type: "success",
        });
        onOpenChange(false);
        return;
      }

      const failedUrls = new Set(
        result.failed.map((failure) => failure.sourceUrl),
      );
      setDiscovery((current) =>
        current
          ? {
              ...current,
              skills: current.skills.filter((skill) =>
                failedUrls.has(skill.sourceUrl),
              ),
            }
          : null,
      );
      setSelected(failedUrls);
      stellaToast.add({
        title: tSkills("importPartial", {
          failed: result.failed.length,
          installed: result.installed.length,
        }),
        description: result.failed.at(0)?.message,
        type: "warning",
      });
    },
    onError: (error) => {
      stellaToast.add({
        title: userErrorFromThrown(error, t("common.unexpectedError")),
        type: "error",
      });
    },
  });

  const updateUrl = (nextUrl: string) => {
    setUrl(nextUrl);
    setDiscovery(null);
    setSelected(new Set());
  };

  const toggleSkill = (sourceUrl: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!checked) {
        next.delete(sourceUrl);
        return next;
      }
      if (next.size < MAX_SELECTED_SKILLS) {
        next.add(sourceUrl);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (!discovery) {
      return;
    }
    setSelected(
      new Set(
        discovery.skills
          .slice(0, MAX_SELECTED_SKILLS)
          .map((skill) => skill.sourceUrl),
      ),
    );
  };

  const busy = discover.isPending || importSkills.isPending;

  return (
    <DialogPopup className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{tSkills("importTitle")}</DialogTitle>
        <p className="text-muted-foreground text-sm">{tSkills("importHelp")}</p>
      </DialogHeader>

      <DialogPanel className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label={tSkills("importSkill")}
            className="min-h-11 flex-1 sm:min-h-0"
            dir="ltr"
            disabled={busy}
            onChange={(event) => updateUrl(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                url.trim().length > 0 &&
                !discover.isPending
              ) {
                discover.mutate();
              }
            }}
            placeholder={tSkills("urlPlaceholder")}
            type="url"
            value={url}
          />
          <Button
            className="min-h-11 sm:min-h-0"
            disabled={url.trim().length === 0 || busy}
            onClick={() => discover.mutate()}
            type="button"
            variant="outline"
          >
            {discover.isPending ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <SearchIcon className="size-4" />
            )}
            {tSkills("discoverSkills")}
          </Button>
        </div>

        {discovery && discovery.skills.length === 0 && (
          <div className="flex flex-col gap-2 py-4">
            <p className="text-muted-foreground text-sm">
              {tSkills("discoveryEmpty")}
            </p>
            {discovery.invalidSkillCount > 0 && (
              <p className="text-muted-foreground text-xs">
                {tSkills("discoverySkippedInvalid", {
                  count: discovery.invalidSkillCount,
                })}
              </p>
            )}
          </div>
        )}

        {discovery && discovery.skills.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-muted-foreground text-xs font-medium">
                {tSkills("discoveredSkills", {
                  count: discovery.skills.length,
                })}
              </p>
              {selected.size <
                Math.min(discovery.skills.length, MAX_SELECTED_SKILLS) && (
                <Button
                  disabled={busy}
                  onClick={selectAll}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  {t("common.selectAll")}
                </Button>
              )}
            </div>

            {discovery.skills.length > MAX_SELECTED_SKILLS && (
              <p className="text-muted-foreground text-xs">
                {tSkills("selectionLimit", { count: MAX_SELECTED_SKILLS })}
              </p>
            )}

            <div className="border-border flex max-h-80 flex-col overflow-y-auto rounded-lg border">
              {discovery.skills.map((skill) => {
                const checked = selected.has(skill.sourceUrl);
                const selectionFull =
                  selected.size >= MAX_SELECTED_SKILLS && !checked;
                return (
                  <label
                    className="hover:bg-muted/50 flex min-h-11 items-start gap-3 p-3 transition-colors"
                    key={skill.sourceUrl}
                  >
                    <Checkbox
                      checked={checked}
                      className="mt-0.5"
                      disabled={busy || selectionFull}
                      onCheckedChange={(next) =>
                        toggleSkill(skill.sourceUrl, next)
                      }
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-foreground text-sm font-medium">
                        <bdi>{skill.name}</bdi>
                      </span>
                      <span className="text-muted-foreground text-sm">
                        {skill.description}
                      </span>
                      <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                        {skill.path && (
                          <code dir="ltr">
                            <bdi>{skill.path}</bdi>
                          </code>
                        )}
                        {skill.version && (
                          <span>
                            {tSkills("version", { version: skill.version })}
                          </span>
                        )}
                        {skill.license && (
                          <span>
                            {tSkills("license", { license: skill.license })}
                          </span>
                        )}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>

            {discovery.invalidSkillCount > 0 && (
              <p className="text-muted-foreground text-xs">
                {tSkills("discoverySkippedInvalid", {
                  count: discovery.invalidSkillCount,
                })}
              </p>
            )}

            {canManageTeam && (
              <div className="flex items-center justify-end gap-2">
                <label
                  className="text-muted-foreground text-xs"
                  htmlFor="import-skill-scope"
                >
                  {t("knowledge.skills.form.scope")}
                </label>
                <Select
                  disabled={busy}
                  onValueChange={(value) => {
                    if (value === "team" || value === "private") {
                      setScope(value);
                    }
                  }}
                  value={scope}
                >
                  <SelectTrigger className="w-44" id="import-skill-scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="private">
                      {t("knowledge.skills.form.scopePrivate")}
                    </SelectItem>
                    <SelectItem value="team">
                      {t("knowledge.skills.form.scopeTeam")}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            )}
          </>
        )}
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button disabled={busy} variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        {discovery && discovery.skills.length > 0 && (
          <Button
            disabled={selected.size === 0 || busy}
            onClick={() => importSkills.mutate()}
            type="button"
          >
            {importSkills.isPending && (
              <LoaderIcon className="size-4 animate-spin" />
            )}
            {tSkills("importSelected", { count: selected.size })}
          </Button>
        )}
      </DialogFooter>
    </DialogPopup>
  );
};
