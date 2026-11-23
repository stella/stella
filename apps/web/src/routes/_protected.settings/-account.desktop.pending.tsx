import type { ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";
import {
  ClipboardListIcon,
  FileTextIcon,
  LockKeyholeIcon,
} from "@stll/ui/icons";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { DesktopConnectionCardPending } from "@/features/desktop/desktop-connection-card.pending";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

/*
 * The desktop page's one layout, drawn by both phases: the heading, the
 * link card, and the app's description with its clipboard shortcut and two
 * features. The page fills the slots with the live card, the shortcut for
 * this computer and the self-host note; the pending phase with the card's
 * pending face and a bar where the shortcut will be.
 */

type DesktopFeatureProps = {
  description: PendingTextKey;
  icon: typeof ClipboardListIcon;
  title: PendingTextKey;
};

const DesktopFeature = ({
  description,
  icon: Icon,
  title,
}: DesktopFeatureProps) => (
  <section className="flex items-start gap-3">
    <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-xl">
      <Icon aria-hidden="true" className="size-4" />
    </span>
    <div className="min-w-0">
      <h3 className="text-sm font-medium">
        <PendingText barClassName="w-32" id={title} />
      </h3>
      <p className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty">
        <PendingText barClassName="w-56 max-w-full" id={description} />
      </p>
    </div>
  </section>
);

type DesktopPageShellProps = {
  /** The link card. */
  connectionCard: ReactNode;
  /** The clipboard shortcut for this computer. */
  shortcut: ReactNode;
  /** What the page shows after the description (the self-host note). */
  children?: ReactNode;
};

/** The desktop page's layout, in both phases. */
export const DesktopPageShell = ({
  children,
  connectionCard,
  shortcut,
}: DesktopPageShellProps) => (
  <>
    <SettingsPageHeaderPending
      description="settings.account.desktopDescription"
      title="settings.account.desktop"
    />
    {connectionCard}
    <SettingsSection>
      <SettingsPanel inset="flush">
        <section className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-center">
          <div className="flex max-w-2xl flex-col items-start">
            <h2 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
              <PendingText
                barClassName="w-64 max-w-full"
                id="settings.account.desktopHeroTitle"
              />
            </h2>
            <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-relaxed text-pretty">
              <PendingText
                barClassName="w-80 max-w-full"
                id="settings.account.desktopAppDescription"
              />
            </p>
          </div>

          <div className="bg-background/72 border-border/60 flex flex-col items-center rounded-2xl border px-5 py-6 text-center shadow-lg/5 backdrop-blur-xl">
            <span className="bg-primary/10 text-primary grid size-11 place-items-center rounded-2xl">
              <ClipboardListIcon aria-hidden="true" className="size-5" />
            </span>
            <p className="mt-3 text-sm font-medium">
              <PendingText
                barClassName="w-32"
                id="settings.account.desktopClipboardTitle"
              />
            </p>
            <kbd
              className="bg-muted border-border mt-3 rounded-lg border px-3 py-1.5 font-mono text-xs shadow-xs"
              dir="ltr"
            >
              {shortcut}
            </kbd>
            <p className="text-muted-foreground mt-3 text-xs leading-relaxed text-pretty">
              <PendingText
                barClassName="w-48 max-w-full"
                id="settings.account.desktopClipboardDescription"
              />
            </p>
          </div>
        </section>
      </SettingsPanel>

      <SettingsPanel>
        <div className="grid gap-4 sm:grid-cols-2">
          <DesktopFeature
            description="settings.account.desktopPrivacyDescription"
            icon={LockKeyholeIcon}
            title="settings.account.desktopPrivacyTitle"
          />
          <DesktopFeature
            description="settings.account.desktopDocumentsDescription"
            icon={FileTextIcon}
            title="settings.account.desktopDocumentsTitle"
          />
        </div>
      </SettingsPanel>
    </SettingsSection>
    {children}
  </>
);

const DesktopPendingView = () => (
  <SettingsPagePending area="account">
    <DesktopPageShell
      connectionCard={<DesktopConnectionCardPending />}
      // Which keys depend on the computer, read once the page mounts.
      shortcut={<FaceLabelPending className="w-20" />}
    />
  </SettingsPagePending>
);

export const DesktopPending = framePendingView(DesktopPendingView);
