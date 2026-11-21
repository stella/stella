import type { DesktopDictationModels } from "@stll/api-contract/desktop-dictation-transcription";

type OfferedModel = DesktopDictationModels["models"][number];

/**
 * The model a recording may go to when the one the person picked could not
 * take it (the server answered 503): only one of the same provider, running
 * on the same side of the organization's region, whose provider keeps the
 * audio exactly when the picked one's does. The audio then reaches no
 * party, place or retention the person did not already choose. The
 * server's default comes first when it qualifies, then the list's order.
 * None when the picked model is not listed, so its provider is unknown, or
 * no other model qualifies: the recording then goes nowhere else.
 */
export const sameClassFallback = (
  pickedId: string,
  offered: DesktopDictationModels,
): string | undefined => {
  const picked = offered.models.find(({ id }) => id === pickedId);
  if (picked === undefined || picked.provider === undefined) {
    return undefined;
  }
  const sameClass = (model: OfferedModel) =>
    model.id !== picked.id &&
    model.provider === picked.provider &&
    (model.outsideRegion === true) === (picked.outsideRegion === true) &&
    (model.retainsData === true) === (picked.retainsData === true);
  const fallbackDefault = offered.models.find(
    (model) => model.id === offered.defaultModelId && sameClass(model),
  );
  return (fallbackDefault ?? offered.models.find(sameClass))?.id;
};
