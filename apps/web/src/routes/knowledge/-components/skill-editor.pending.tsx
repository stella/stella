import {
  FaceLabelPending,
  InputFace,
  SelectTriggerFace,
} from "@stll/ui/control-face";

import { FileTreeRowPending } from "@/components/file-tree/file-tree.pending";
import { PendingText } from "@/components/pending-text";

// The skill editor before its skill is read (a pending-safe module): the
// identity, how the skill runs and its files, on the editor's own lines. The
// skill's own controls (chat, download, enable) join at the identity's end
// once its access is known; nothing below them moves.

const FIELD_LABEL_CLASS = "text-muted-foreground mt-1.5 text-xs/4";

/** The editor's files while the skill is read: its SKILL.md row, which
 *  every skill has. */
export const SkillFilesPending = () => (
  <FileTreeRowPending nameClassName="w-16" />
);

/** A skill's editor before the skill has been read. */
export const SkillEditorPending = () => (
  <div aria-hidden="true" className="flex min-h-0 w-full flex-1 flex-col">
    <div className="border-b p-4" data-slot="skill-editor-identity">
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-foreground-placeholder text-lg font-semibold">
          <PendingText barClassName="w-24" id="common.name" />
        </p>
        <p className="text-foreground-placeholder text-sm leading-relaxed">
          <PendingText barClassName="w-32" id="common.description" />
        </p>
      </div>
      <div className="mt-3 border-t pt-3">
        <p className="text-muted-foreground mb-2.5 text-xs font-semibold tracking-wider uppercase">
          <PendingText
            barClassName="w-20"
            id="knowledge.agentSkills.howItRuns"
          />
        </p>
        <div className="grid max-w-3xl grid-cols-[9rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5">
          <span className={FIELD_LABEL_CLASS}>
            <PendingText
              barClassName="w-28"
              id="knowledge.skills.commandLabel"
            />
          </span>
          <div className="flex flex-col gap-1">
            <div className="flex items-stretch">
              <span className="bg-muted border-border flex items-center rounded-s-md border border-e-0 px-2 text-xs">
                /
              </span>
              <InputFace>
                <PendingText
                  barClassName="w-20"
                  id="knowledge.skills.commandPlaceholder"
                />
              </InputFace>
            </div>
            <p className="text-muted-foreground text-xs">
              <PendingText
                barClassName="w-48"
                id="knowledge.skills.commandHelp"
              />
            </p>
          </div>
          <span className={FIELD_LABEL_CLASS}>
            <PendingText barClassName="w-20" id="common.whenToUse" />
          </span>
          <div className="flex flex-col gap-1">
            <SelectTriggerFace className="w-fit min-w-48">
              <FaceLabelPending className="w-24" />
            </SelectTriggerFace>
            <p className="text-muted-foreground text-xs">
              <FaceLabelPending className="w-56" />
            </p>
          </div>
        </div>
      </div>
    </div>
    <div className="p-3">
      <p
        className="text-muted-foreground mb-2 px-1 text-xs font-semibold tracking-wider uppercase"
        data-slot="skill-editor-files"
      >
        <PendingText barClassName="w-10" id="common.files" />
      </p>
      <SkillFilesPending />
    </div>
  </div>
);
