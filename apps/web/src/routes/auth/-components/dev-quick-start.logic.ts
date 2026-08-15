export const DEV_QUICK_START_PHASE = {
  authenticate: "authenticate",
  organization: "organization",
  skills: "skills",
  matters: "matters",
} as const;

export type DevQuickStartPhase =
  (typeof DEV_QUICK_START_PHASE)[keyof typeof DEV_QUICK_START_PHASE];

export type DevQuickStartIdentity = {
  email: string;
  organizationName: string;
  organizationSlug: string;
  selectionSeed: string;
};

const DEV_QUICK_START_EMAIL = "dev-quick-start@stella.dev";

export const createDevQuickStartIdentity = (
  randomId: string,
): DevQuickStartIdentity => {
  const compactId = randomId.replaceAll("-", "").toLowerCase();
  const label = compactId.slice(0, 8);
  return {
    email: DEV_QUICK_START_EMAIL,
    organizationName: `Harvey LAB ${label.toUpperCase()}`,
    organizationSlug: `dev-quick-start-${compactId}`,
    selectionSeed: randomId,
  };
};

type RunDevQuickStartOptions = {
  authenticate: (identity: DevQuickStartIdentity) => Promise<void>;
  createOrganization: (identity: DevQuickStartIdentity) => Promise<void>;
  onPhase: (phase: DevQuickStartPhase) => void;
  randomId: string;
  seedMatters: (identity: DevQuickStartIdentity) => Promise<void>;
  seedSkills: () => Promise<void>;
};

/** Runs the production-shaped boundaries in ownership order. */
export const runDevQuickStart = async ({
  authenticate,
  createOrganization,
  onPhase,
  randomId,
  seedMatters,
  seedSkills,
}: RunDevQuickStartOptions): Promise<DevQuickStartIdentity> => {
  const identity = createDevQuickStartIdentity(randomId);

  onPhase(DEV_QUICK_START_PHASE.authenticate);
  await authenticate(identity);

  onPhase(DEV_QUICK_START_PHASE.organization);
  await createOrganization(identity);

  onPhase(DEV_QUICK_START_PHASE.skills);
  await seedSkills();

  onPhase(DEV_QUICK_START_PHASE.matters);
  await seedMatters(identity);

  return identity;
};
