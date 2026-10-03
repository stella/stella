declare const request: () => Promise<void>;
declare const recordFailure: (error: unknown) => void;

export const observeTestRequests = async () => {
  // oxlint-disable-next-line no-swallowed-item-error/no-test-swallowed-error -- fixture: an unobserved request rejection must fail the test
  await request().catch(() => undefined);
  // oxlint-disable-next-line no-swallowed-item-error/no-test-swallowed-error -- fixture: an empty handler has no observable failure
  await request().catch(() => {});
  try {
    await request();
  }
  // oxlint-disable-next-line no-swallowed-item-error/no-test-swallowed-error -- fixture: a comment alone does not justify discarding failures
  catch {
    // Deliberately no outcome assertion.
  }
  // oxlint-disable-next-line no-swallowed-item-error/no-test-swallowed-error -- fixture: a placeholder reason cannot allow a swallowed failure
  await request().catch(() => null); // swallow-ok: TODO explain why this request is optional
  // expect-clean: no-swallowed-item-error/no-test-swallowed-error
  await request().catch(() => undefined); // swallow-ok: drains a reader after its original error has been asserted
  try {
    await request();
  }
  // expect-clean: no-swallowed-item-error/no-test-swallowed-error
  catch (error) {
    recordFailure(error);
    throw error;
  }
};
