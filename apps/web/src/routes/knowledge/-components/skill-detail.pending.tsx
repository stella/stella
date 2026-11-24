import { FaceLabelPending } from "@stll/ui/control-face";

import { FileTreeRowPending } from "@/components/file-tree/file-tree.pending";
import { PendingText } from "@/components/pending-text";

/** The editor's files while the skill is read. */
export const SkillFilesPending = () => (
  <FileTreeRowPending nameClassName="w-16" />
);

/** A skill's editor before the skill has been read. */
export const SkillDetailPending = () => (
  <div aria-hidden="true" className="flex min-h-0 w-full flex-1 flex-col">
    <div className="border-b px-6 py-4" data-slot="skill-editor-identity">
      <div className="mx-auto flex w-full max-w-4xl items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-foreground-placeholder text-xl font-semibold tracking-tight">
            <PendingText barClassName="w-28" id="common.name" />
          </p>
          <p className="text-foreground-placeholder text-sm leading-relaxed">
            <PendingText barClassName="w-48" id="common.description" />
          </p>
        </div>
      </div>
    </div>
    <div className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-5">
        <div data-slot="skill-editor-instructions">
          <div className="overflow-hidden rounded-xl border">
            <div className="flex items-center border-b px-3 py-2">
              <FaceLabelPending className="w-20" />
            </div>
            <div className="p-4">
              <SkillFilesPending />
            </div>
          </div>
        </div>
        <div className="overflow-hidden rounded-xl border">
          <div className="flex items-center border-b px-3 py-2">
            <span data-slot="skill-editor-files">
              <FaceLabelPending className="w-16" />
            </span>
          </div>
          <div className="p-2">
            <SkillFilesPending />
          </div>
        </div>
      </div>
    </div>
  </div>
);
