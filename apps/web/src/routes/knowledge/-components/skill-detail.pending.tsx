import {
  FaceLabelPending,
  InputFace,
  SelectTriggerFace,
} from "@stll/ui/control-face";

import { FileTreeRowPending } from "@/components/file-tree/file-tree.pending";
import { PendingText } from "@/components/pending-text";

// A skill's page before its skill is read (a pending-safe module): the
// editor's identity, how the skill runs and where it is available, and its
// files, on the editor's own lines. The skill's own controls (chat, export,
// enable) join at the identity's end once its access is known; nothing below
// them moves. Named for the page, not the editor: the pending closure keeps
// editor modules out of the cold-load frame by name.

const FIELD_LABEL_CLASS = "text-muted-foreground mt-1.5 text-xs/4";

/** The editor's files while the skill is read: its SKILL.md row, which
 *  every skill has. */
export const SkillFilesPending = () => (
  <FileTreeRowPending nameClassName="w-16" />
);

/** A skill's editor before the skill has been read. */
export const SkillDetailPending = () => (
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
          <span className="text-muted-foreground pt-0.5 text-xs">
            <PendingText
              barClassName="w-20"
              id="knowledge.agentSkills.availabilityLabel"
            />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-sm">
              <FaceLabelPending className="w-24" />
            </span>
            <p className="text-muted-foreground text-xs">
              <PendingText
                barClassName="w-64"
                id="knowledge.agentSkills.availabilityFixedHelp"
              />
            </p>
          </div>
        </div>
      </div>
    </div>
    <div className="p-3">
      <div className="mb-2 flex items-center gap-1 px-1">
        <p
          className="text-muted-foreground me-auto text-xs font-semibold tracking-wider uppercase"
          data-slot="skill-editor-files"
        >
          <PendingText barClassName="w-10" id="common.files" />
        </p>
      </div>
      <SkillFilesPending />
    </div>
  </div>
);
