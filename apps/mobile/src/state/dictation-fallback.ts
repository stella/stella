import * as v from "valibot";

import type { DesktopDictationModels } from "@stll/api-contract/desktop-dictation-transcription";

type OfferedModel = DesktopDictationModels["models"][number];

/**
 * Where a model's audio goes: who runs it, whether outside the
 * organization's region, and whether its provider keeps the audio. Kept
 * with the picked model, as a withdrawn model is no longer in the list.
 */
export type ModelClass = {
  readonly provider: string;
  readonly outsideRegion: boolean;
  readonly retainsData: boolean;
};

export const modelClassSchema = v.object({
  provider: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  outsideRegion: v.boolean(),
  retainsData: v.boolean(),
});

/** A listed model's class; null when the list names no provider for it. */
export const classOf = (model: OfferedModel): ModelClass | null =>
  model.provider === undefined
    ? null
    : {
        provider: model.provider,
        outsideRegion: model.outsideRegion === true,
        retainsData: model.retainsData === true,
      };

/**
 * The model a recording may go to when the one the person picked could not
 * take it (the server answered 503, or no longer offers it): only one of
 * the same provider, on the same side of the organization's region, whose
 * provider keeps the audio exactly when the picked one's does. The audio
 * then reaches no party, place or retention the person did not already
 * choose. The picked model's class comes from the list, or, once it is
 * withdrawn, from `pickedClass` as kept when it was picked. The server's
 * default comes first when it qualifies, then the list's order. None when
 * the class is unknown or no other model qualifies: the recording then
 * goes nowhere else.
 */
export const sameClassFallback = (
  pickedId: string,
  pickedClass: ModelClass | null,
  offered: DesktopDictationModels,
): string | undefined => {
  const listed = offered.models.find(({ id }) => id === pickedId);
  const picked = listed === undefined ? pickedClass : classOf(listed);
  if (picked === null) {
    return undefined;
  }
  const sameClass = (model: OfferedModel) => {
    const other = classOf(model);
    return (
      model.id !== pickedId &&
      other !== null &&
      other.provider === picked.provider &&
      other.outsideRegion === picked.outsideRegion &&
      other.retainsData === picked.retainsData
    );
  };
  const fallbackDefault = offered.models.find(
    (model) => model.id === offered.defaultModelId && sameClass(model),
  );
  return (fallbackDefault ?? offered.models.find(sameClass))?.id;
};
