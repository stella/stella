import type { ReactNode } from "react";

import { InputFace, LabelFace, SelectTriggerFace } from "@stll/ui/control-face";

import { PendingText, type PendingTextKey } from "@/components/pending-text";

export const DEFAULT_SKILL_LICENSE = "MIT";

export const ToolContributeShell = ({ children }: { children: ReactNode }) => (
  <main className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">
          <PendingText id="publicTools.contribute.title" />
        </h1>
        <p className="text-muted-foreground text-sm">
          <PendingText
            barClassName="w-72 max-w-full"
            id="publicTools.contribute.intro"
          />
        </p>
      </div>
      {children}
    </div>
  </main>
);

export const ContributeFormShell = ({ children }: { children: ReactNode }) => (
  <section className="border-border flex flex-col gap-4 rounded-lg border p-4">
    <h2 className="text-base font-semibold">
      <PendingText id="publicTools.contribute.form.title" />
    </h2>
    <p className="text-muted-foreground text-sm">
      <PendingText
        barClassName="w-72 max-w-full"
        id="publicTools.contribute.form.intro"
      />
    </p>
    {children}
  </section>
);

const ContributeFieldFace = ({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: PendingTextKey;
  label: PendingTextKey;
}) => (
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

/** The contribute page before its form is interactive; both the
 *  `/knowledge/tools/contribute` and the legacy `/tools/contribute` routes
 *  draw it. */
export const ToolContributeFormPending = () => (
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
);
