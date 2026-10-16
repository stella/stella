// oxlint-disable-next-line no-hand-rolled-reference-chip/no-hand-rolled-reference-chip -- fixture: the href codec outside the references module
import { parseChatResourceHref } from "@stll/api-contract";
import type { ChatMentionResourceHref } from "@stll/api-contract";
import { FileTextIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";

import { InlinePill } from "@/components/inline-pill";

declare const matterId: string;
declare const label: string;

// A chip shell plus a reference glyph, even through a variable, is a
// hand-rolled reference chip.
const matterIcon = (
  // oxlint-disable-next-line no-hand-rolled-reference-chip/no-hand-rolled-reference-chip -- fixture: glyph in a hand-rolled chip
  <MatterIcon matter={{ id: matterId, color: null }} />
);
const _handRolled = <InlinePill leadingIcon={matterIcon}>{label}</InlinePill>;

// Spelling a reference href by hand is the codec outside its module.
// oxlint-disable-next-line no-hand-rolled-reference-chip/no-hand-rolled-reference-chip -- fixture: hand-built reference href
const _href = `#stella-entity=${matterId}`;
// oxlint-disable-next-line no-hand-rolled-reference-chip/no-hand-rolled-reference-chip -- fixture: hand-built reference href
const _userHref = "#stella-user=user-1";

// A citation chip with a non-reference glyph, a type-only import of the codec
// types, and non-reference hash links stay valid.
// expect-clean: no-hand-rolled-reference-chip/no-hand-rolled-reference-chip
const _citation = (
  <InlinePill leadingIcon={<FileTextIcon className="size-3" />}>
    {label}
  </InlinePill>
);
const _folio = "#folio:seq-1";
const _skill = "#stella-skill-ref=nda-review";
const _typed: ChatMentionResourceHref | null = null;

export const __noHandRolledReferenceChipFixture = {
  _citation,
  _folio,
  _handRolled,
  _href,
  _skill,
  _typed,
  _userHref,
  parseChatResourceHref,
};
