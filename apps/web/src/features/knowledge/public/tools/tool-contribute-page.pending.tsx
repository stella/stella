import type { ReactNode } from "react";

import { InputFace, LabelFace } from "@stll/ui/control-face";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

// The contribute page in both phases (a pending-safe module): the loaded page
// renders these frames with its form, the pending view with the form's first
// fields as faces.

/** The page's column and its heading. */
export const ContributePageFrame = ({
  title,
  intro,
  className,
  children,
}: {
  /** How the loaded page scrolls; the pending one does not. */
  className?: string | undefined;
  title: ReactNode;
  intro: ReactNode;
  children: ReactNode;
}) => (
  <main className={cn("min-h-0 flex-1", className)}>
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-muted-foreground text-sm">{intro}</p>
      </div>
      {children}
    </div>
  </main>
);

/** The add-a-skill form's card and heading. */
export const ContributeFormFrame = ({
  title,
  intro,
  children,
}: {
  title: ReactNode;
  intro: ReactNode;
  children: ReactNode;
}) => (
  <section className="border-border flex flex-col gap-4 rounded-lg border p-4">
    <h2 className="text-base font-semibold">{title}</h2>
    <p className="text-muted-foreground text-sm">{intro}</p>
    {children}
  </section>
);

/** The contribute page before its form is there. */
export const ContributePagePending = () => (
  <ContributePageFrame
    intro={
      <PendingText barClassName="w-80" id="publicTools.contribute.intro" />
    }
    title={
      <PendingText barClassName="w-48" id="publicTools.contribute.title" />
    }
  >
    <ContributeFormFrame
      intro={
        <PendingText
          barClassName="w-72"
          id="publicTools.contribute.form.intro"
        />
      }
      title={
        <PendingText
          barClassName="w-40"
          id="publicTools.contribute.form.title"
        />
      }
    >
      <div className="flex flex-col gap-1.5">
        <LabelFace>
          <PendingText
            barClassName="w-12"
            id="publicTools.contribute.form.name"
          />
        </LabelFace>
        <InputFace />
      </div>
      <div className="flex flex-col gap-1.5">
        <LabelFace>
          <PendingText
            barClassName="w-12"
            id="publicTools.contribute.form.slugLabel"
          />
        </LabelFace>
        <InputFace />
        <p className="text-muted-foreground text-xs">
          <PendingText
            barClassName="w-64"
            id="publicTools.contribute.form.slugHint"
          />
        </p>
      </div>
    </ContributeFormFrame>
  </ContributePageFrame>
);
