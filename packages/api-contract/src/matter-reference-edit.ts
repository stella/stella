type ReferenceEdit =
  | { type: "discard" }
  | { type: "confirm"; reference: string }
  | { type: "save"; reference: string };

type ResolveReferenceEditOptions = {
  currentReference: string;
  nextReference: string;
  stampedVersionCount: number;
};

// A stamped version freezes the reference it was issued under, so moving the
// matter reference strands every printed copy on the old one. That is only
// worth a confirmation once at least one version carries a stamp; before then
// there is nothing to strand.
export const resolveReferenceEdit = ({
  currentReference,
  nextReference,
  stampedVersionCount,
}: ResolveReferenceEditOptions): ReferenceEdit => {
  const reference = nextReference.trim();

  if (reference === "" || reference === currentReference) {
    return { type: "discard" };
  }

  return stampedVersionCount > 0
    ? { type: "confirm", reference }
    : { type: "save", reference };
};
