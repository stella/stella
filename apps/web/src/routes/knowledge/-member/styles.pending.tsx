import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { CogIcon, FileTextIcon, PlusIcon, UploadIcon } from "@stll/ui/icons";
import { InlineSkeleton } from "@stll/ui/skeleton";
import { TruncatedTextFace } from "@stll/ui/truncated-text-face";
import { cn } from "@stll/ui/utils";

import { usePendingCache } from "@/components/pending-cache";
import { PendingText } from "@/components/pending-text";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The house styles page: its header, with the create actions at its end,
 *  over the list of style sets, which each phase draws in its own box (the
 *  loaded page's scrolls). Both phases draw it. */
export const StyleSetsShell = ({
  actions,
  children,
  description,
  title,
}: {
  actions: ReactNode;
  children: ReactNode;
  description: ReactNode;
  title: ReactNode;
}) => (
  <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center justify-between border-b px-6 py-3">
      <div>
        <h1 className="text-sm font-semibold">{title}</h1>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      {actions}
    </div>
    {children}
  </div>
);

/** The list of style sets. */
export const StyleSetList = ({ children }: { children: ReactNode }) => (
  <ul className="divide-y" data-slot="style-set-list">
    {children}
  </ul>
);

/** A style set's row: its document tile, name, the line under it and its
 *  actions. */
export const StyleSetRow = ({
  description,
  name,
  placeholder = false,
  trailing,
}: {
  description: ReactNode;
  name: ReactNode;
  /** A row standing in for one that loads: hidden from assistive tech. */
  placeholder?: boolean | undefined;
  trailing: ReactNode;
}) => (
  <li
    aria-hidden={placeholder || undefined}
    className="flex items-center gap-3 px-6 py-4"
  >
    <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
      <FileTextIcon className="text-muted-foreground size-5" />
    </div>
    <div className="flex min-w-0 flex-1 flex-col">
      {name}
      {description}
    </div>
    {trailing}
  </li>
);

/** The default badge on the stella style's row. */
export const StyleSetDefaultBadge = ({ children }: { children: ReactNode }) => (
  <span className="bg-muted rounded-full px-2 py-1 text-xs font-medium">
    {children}
  </span>
);

const ROW_KEYS = ["a", "b", "c"];
const NAME_WIDTHS = ["w-40", "w-52", "w-32"];

/** The house styles page while the organization's style sets load: the
 *  stella style, which every organization has, and placeholder rows. */
export const StyleSetsPending = framePendingView(() => {
  const cache = usePendingCache();
  const canCreate =
    cache !== null && cachedRoleGrants(cache, { styleSet: ["create"] });
  return (
    <StyleSetsShell
      actions={
        canCreate && (
          <div className="flex items-center gap-2">
            <ButtonFace size="sm" variant="outline">
              <UploadIcon />
              <PendingText barClassName="w-12" id="styleSets.import" />
            </ButtonFace>
            <ButtonFace size="sm" variant="default">
              <PlusIcon />
              <PendingText barClassName="w-16" id="styleSets.create" />
            </ButtonFace>
          </div>
        )
      }
      description={
        <PendingText barClassName="w-72" id="styleSets.description" />
      }
      title={<PendingText barClassName="w-28" id="styleSets.title" />}
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        <StyleSetList>
          <StyleSetRow
            description={
              <span className="text-muted-foreground text-xs">
                <TruncatedTextFace>
                  <PendingText
                    barClassName="w-48"
                    id="styleSets.stellaDescription"
                  />
                </TruncatedTextFace>
              </span>
            }
            name={
              <span className="text-sm font-medium">
                <TruncatedTextFace>
                  <PendingText barClassName="w-24" id="styleSets.stellaStyle" />
                </TruncatedTextFace>
              </span>
            }
            trailing={
              <div className="flex items-center gap-2">
                <StyleSetDefaultBadge>
                  <PendingText
                    barClassName="w-10"
                    id="styleSets.defaultBadge"
                  />
                </StyleSetDefaultBadge>
                {canCreate && (
                  <ButtonFace size="icon-xs" variant="ghost">
                    <CogIcon />
                  </ButtonFace>
                )}
              </div>
            }
          />
          {ROW_KEYS.map((key, index) => (
            <StyleSetRow
              description={
                <span className="flex h-4 items-center">
                  <InlineSkeleton className="h-3 w-20" />
                </span>
              }
              key={key}
              name={
                <span className="flex h-5 items-center">
                  <InlineSkeleton className={cn("h-3.5", NAME_WIDTHS[index])} />
                </span>
              }
              placeholder
              trailing={null}
            />
          ))}
        </StyleSetList>
      </div>
    </StyleSetsShell>
  );
});
