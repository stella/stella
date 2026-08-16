import { panic } from "better-result";

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

export type DevQuickStartAttempt = {
  completedPhase: DevQuickStartPhase | null;
  identity: DevQuickStartIdentity;
  organizationId: string | null;
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
  attempt: DevQuickStartAttempt;
  authenticate: (identity: DevQuickStartIdentity) => Promise<void>;
  createOrganization: (identity: DevQuickStartIdentity) => Promise<string>;
  onAttemptUpdated: (attempt: DevQuickStartAttempt) => void;
  onPhase: (phase: DevQuickStartPhase) => void;
  seedMatters: (
    identity: DevQuickStartIdentity,
    organizationId: string,
  ) => Promise<void>;
  seedSkills: (organizationId: string) => Promise<void>;
};

const PHASE_ORDER = {
  [DEV_QUICK_START_PHASE.authenticate]: 0,
  [DEV_QUICK_START_PHASE.organization]: 1,
  [DEV_QUICK_START_PHASE.skills]: 2,
  [DEV_QUICK_START_PHASE.matters]: 3,
} as const satisfies Record<DevQuickStartPhase, number>;

const shouldRunPhase = (
  completedPhase: DevQuickStartPhase | null,
  phase: DevQuickStartPhase,
): boolean =>
  completedPhase === null || PHASE_ORDER[phase] > PHASE_ORDER[completedPhase];

/** Runs the production-shaped boundaries in ownership order. */
export const runDevQuickStart = async ({
  attempt,
  authenticate,
  createOrganization,
  onAttemptUpdated,
  onPhase,
  seedMatters,
  seedSkills,
}: RunDevQuickStartOptions): Promise<void> => {
  let currentAttempt = attempt;
  const completePhase = (
    completedPhase: DevQuickStartPhase,
    organizationId = currentAttempt.organizationId,
  ) => {
    currentAttempt = {
      completedPhase,
      identity: currentAttempt.identity,
      organizationId,
    };
    onAttemptUpdated(currentAttempt);
  };

  if (
    shouldRunPhase(
      currentAttempt.completedPhase,
      DEV_QUICK_START_PHASE.authenticate,
    )
  ) {
    onPhase(DEV_QUICK_START_PHASE.authenticate);
    await authenticate(currentAttempt.identity);
    completePhase(DEV_QUICK_START_PHASE.authenticate);
  }

  if (
    shouldRunPhase(
      currentAttempt.completedPhase,
      DEV_QUICK_START_PHASE.organization,
    )
  ) {
    onPhase(DEV_QUICK_START_PHASE.organization);
    const organizationId = await createOrganization(currentAttempt.identity);
    completePhase(DEV_QUICK_START_PHASE.organization, organizationId);
  }

  const organizationId =
    currentAttempt.organizationId ??
    panic("Dev quick start completed organization setup without an ID.");

  if (
    shouldRunPhase(currentAttempt.completedPhase, DEV_QUICK_START_PHASE.skills)
  ) {
    onPhase(DEV_QUICK_START_PHASE.skills);
    await seedSkills(organizationId);
    completePhase(DEV_QUICK_START_PHASE.skills);
  }

  if (
    shouldRunPhase(currentAttempt.completedPhase, DEV_QUICK_START_PHASE.matters)
  ) {
    onPhase(DEV_QUICK_START_PHASE.matters);
    await seedMatters(currentAttempt.identity, organizationId);
    completePhase(DEV_QUICK_START_PHASE.matters);
  }
};
