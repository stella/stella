type SingleFlightState = {
  current: Promise<void> | null;
};

/**
 * Run one leading operation and share it with every concurrent caller.
 * A new operation may start only after the active promise settles.
 */
export const runLeadingSingleFlight = async (
  state: SingleFlightState,
  operation: () => Promise<void>,
): Promise<void> => {
  if (state.current !== null) {
    await state.current;
    return;
  }

  const current = operation().finally(() => {
    if (state.current === current) {
      state.current = null;
    }
  });
  state.current = current;
  await current;
};
