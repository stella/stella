type ActiveTouchChangeOptions = {
  activeTouchIdentifier: number | null;
  changedTouchIdentifiers: readonly number[];
};

export const isActiveTouchChange = ({
  activeTouchIdentifier,
  changedTouchIdentifiers,
}: ActiveTouchChangeOptions) =>
  activeTouchIdentifier === null ||
  changedTouchIdentifiers.includes(activeTouchIdentifier);
