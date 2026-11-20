import type { ReactNode } from "react";

import { InputFace, LabelFace, SelectTriggerFace } from "@stll/ui/control-face";

import { PendingText, type PendingTextKey } from "@/components/pending-text";
import {
  ContributeFormShell,
  DEFAULT_SKILL_LICENSE,
  ToolContributeShell,
} from "@/features/knowledge/public/tools/tool-contribute-shell.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

export { ToolContributeShell } from "@/features/knowledge/public/tools/tool-contribute-shell.pending";

function ContributeFieldFace({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: PendingTextKey;
  label: PendingTextKey;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <LabelFace>
        <PendingText id={label} />
      </LabelFace>
      {children}
      {hint !== undefined && (
        <p className="text-muted-foreground text-xs">
          <PendingText barClassName="w-64 max-w-full" id={hint} />
        </p>
      )}
    </div>
  );
}

export const ToolContributePending = framePendingView(() => (
  <ToolContributeShell>
    <ContributeFormShell>
      <ContributeFieldFace label="publicTools.contribute.form.name">
        <InputFace />
      </ContributeFieldFace>
      <ContributeFieldFace
        hint="publicTools.contribute.form.slugHint"
        label="publicTools.contribute.form.slugLabel"
      >
        <InputFace />
      </ContributeFieldFace>
      <ContributeFieldFace label="common.description">
        <InputFace className="min-h-18 max-sm:min-h-21" />
      </ContributeFieldFace>
      <div className="grid gap-4 sm:grid-cols-2">
        <ContributeFieldFace label="publicTools.contribute.form.authorLabel">
          <InputFace />
        </ContributeFieldFace>
        <ContributeFieldFace label="publicTools.contribute.form.authorUrlLabel">
          <InputFace />
        </ContributeFieldFace>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <ContributeFieldFace label="publicTools.contribute.form.licenseLabel">
          <SelectTriggerFace>{DEFAULT_SKILL_LICENSE}</SelectTriggerFace>
        </ContributeFieldFace>
        <ContributeFieldFace label="publicTools.contribute.form.costLabel">
          <SelectTriggerFace>
            <PendingText id="catalogue.cost.free" />
          </SelectTriggerFace>
        </ContributeFieldFace>
        <ContributeFieldFace label="publicTools.contribute.form.setupLabel">
          <SelectTriggerFace>
            <PendingText id="catalogue.setup.none" />
          </SelectTriggerFace>
        </ContributeFieldFace>
      </div>
    </ContributeFormShell>
  </ToolContributeShell>
));
