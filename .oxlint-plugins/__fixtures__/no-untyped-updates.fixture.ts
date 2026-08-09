// Passive regression fixture for no-untyped-updates.

// oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- fixture: unknown update bags bypass field checking
export const unknownUpdate: Record<string, unknown> = { title: "Matter" };

// oxlint-disable-next-line no-untyped-updates/no-untyped-updates, typescript/no-explicit-any -- fixture: any-valued update bags have the same defect
export const anyUpdate: Record<string, any> = { title: "Matter" };

type MatterUpdate = Partial<{ title: string; status: string }>;
export const typedUpdate: MatterUpdate = { title: "Matter" };
