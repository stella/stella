import type { ReactNode } from "react";

import { PendingText } from "@/components/pending-text";

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
