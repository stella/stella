declare const tx: {
  $count: (table: unknown) => Promise<number>;
  update: (table: unknown) => { set: (values: unknown) => Promise<void> };
};
declare const runs: unknown;
declare const findings: unknown;
declare const expected: number;

// Planted: finishes a run once a count of its rows reaches the plan, with no
// registered overlap suite.
// oxlint-disable-next-line count-gated-completion/count-gated-completion -- planted count-gated completion must be rejected
export const finishWhenCounted = async () => {
  if ((await tx.$count(findings)) === expected) {
    await tx.update(runs).set({ status: "completed" });
  }
};

// expect-clean: count-gated-completion/count-gated-completion
export const recordProgress = async () => {
  await tx.update(runs).set({ completed: await tx.$count(findings) });
};
