import {
  normalizePosition,
  type Position,
} from "@/lib/knowledge/playbook-types";

type ResolvePlaybookScrollTopArgs = {
  containerScrollTop: number;
  containerTop: number;
  targetTop: number;
  topOffset: number;
};

export const resolvePlaybookScrollTop = ({
  containerScrollTop,
  containerTop,
  targetTop,
  topOffset,
}: ResolvePlaybookScrollTopArgs) =>
  Math.max(0, containerScrollTop + targetTop - containerTop - topOffset);

type PlaybookDraft = {
  name: string;
  description: string;
  documentTypeKey: string | null;
  positions: readonly Position[];
};

type HasPlaybookDraftChangesArgs = {
  initial: PlaybookDraft;
  current: PlaybookDraft;
};

const playbookDraftFingerprint = ({
  name,
  description,
  documentTypeKey,
  positions,
}: PlaybookDraft) =>
  JSON.stringify({
    name: name.trim(),
    description: description.trim(),
    documentTypeKey,
    positions: positions.map(normalizePosition),
  });

export const hasPlaybookDraftChanges = ({
  initial,
  current,
}: HasPlaybookDraftChangesArgs) =>
  playbookDraftFingerprint(initial) !== playbookDraftFingerprint(current);
