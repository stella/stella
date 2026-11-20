import type { ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

/*
 * One of the organization's identifiers (its slug, its id) as the General
 * page shows it: a titled card with one line on what the identifier is for,
 * the value in monospace and one action at the end. The slug card and the id panel render `IdentifierPanel`; the
 * pending phase renders `IdentifierPanelPending`, with a bar where the value
 * will be, so the value that loads lands on its own line.
 */

type IdentifierPanelProps = {
  /** The identifier's name, as the panel's `h2`. */
  title: ReactNode;
  /** One line on what the identifier is for. */
  description: ReactNode;
  /** The value, or a bar while it waits on data. */
  value: ReactNode;
  /** The panel's one action (change, copy), when the member has it. */
  action?: ReactNode;
};

/** An identifier's panel, in both phases. */
export const IdentifierPanel = ({
  action,
  description,
  title,
  value,
}: IdentifierPanelProps) => (
  <Frame>
    <FramePanel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-muted-foreground text-sm">{description}</p>
          <bdi className="font-mono text-sm break-all">{value}</bdi>
        </div>
        {action}
      </div>
    </FramePanel>
  </Frame>
);

/** The panel before its value is known: the real title and line, a bar, the
 *  action's face. */
export const IdentifierPanelPending = ({
  action,
  description,
  title,
}: {
  title: PendingTextKey;
  description: PendingTextKey;
  action: ReactNode;
}) => (
  <IdentifierPanel
    action={action}
    description={
      <PendingText barClassName="w-72 max-w-full" id={description} />
    }
    title={<PendingText barClassName="w-32" id={title} />}
    value={<FaceLabelPending className="w-56 max-w-full" />}
  />
);
