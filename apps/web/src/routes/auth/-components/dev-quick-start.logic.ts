import { panic, Result, TaggedError } from "better-result";

export const DEV_QUICK_START_PHASE = {
  authenticate: "authenticate",
  organization: "organization",
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

export const DEV_QUICK_START_STAGE = {
  authenticate: "authenticate",
  continue: "continue",
} as const;

type DevQuickStartStage =
  (typeof DEV_QUICK_START_STAGE)[keyof typeof DEV_QUICK_START_STAGE];

type SingleFlightOptions = {
  stage: DevQuickStartStage;
  run: () => Promise<void>;
};

/** Owns one tab's attempt across component lifetimes, including failed retries. */
export const createDevQuickStartRuntime = () => {
  let attempt: DevQuickStartAttempt | null = null;
  let phase: DevQuickStartPhase | null = null;
  let flight: { stage: DevQuickStartStage; promise: Promise<void> } | null =
    null;
  const listeners = new Set<() => void>();

  const setPhase = (nextPhase: DevQuickStartPhase | null) => {
    phase = nextPhase;
    for (const listener of listeners) {
      listener();
    }
  };

  const runSingleFlight = async ({
    stage,
    run,
  }: SingleFlightOptions): Promise<void> => {
    if (flight !== null) {
      if (flight.stage === stage) {
        return flight.promise;
      }
      // Navigation can mount the continuation before authentication settles.
      await flight.promise;
      return runSingleFlight({ stage, run });
    }

    const promise = Promise.resolve()
      .then(run)
      .finally(() => {
        flight = null;
        setPhase(null);
      });
    flight = { stage, promise };
    return promise;
  };

  return {
    getAttempt: (restore: () => DevQuickStartAttempt) => {
      attempt ??= restore();
      return attempt;
    },
    getPhase: () => phase,
    runSingleFlight,
    setAttempt: (nextAttempt: DevQuickStartAttempt) => {
      attempt = nextAttempt;
    },
    setPhase,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export const startDevQuickStartAttempt = (
  attempt: DevQuickStartAttempt,
  createIdentity: () => DevQuickStartIdentity,
): DevQuickStartAttempt => {
  if (attempt.completedPhase !== DEV_QUICK_START_PHASE.matters) {
    return attempt;
  }
  return {
    completedPhase: null,
    identity: createIdentity(),
    organizationId: null,
  };
};

type ResolveDevQuickStartOrganizationOptions = {
  identity: DevQuickStartIdentity;
  listOrganizations: () => Promise<readonly { id: string; slug: string }[]>;
  createOrganization: (identity: DevQuickStartIdentity) => Promise<string>;
};

class DevQuickStartOrganizationError extends TaggedError(
  "DevQuickStartOrganizationError",
)<{
  message: string;
  cause: unknown;
}> {}

type ResolveDevQuickStartOrganizationResult = Result<
  string,
  DevQuickStartOrganizationError
>;

const toOrganizationError = (cause: unknown) =>
  new DevQuickStartOrganizationError({
    message: "Dev quick start organization setup failed.",
    cause,
  });

export const resolveDevQuickStartOrganization = async ({
  identity,
  listOrganizations,
  createOrganization,
}: ResolveDevQuickStartOrganizationOptions): Promise<ResolveDevQuickStartOrganizationResult> => {
  const organizations = await Result.tryPromise({
    try: listOrganizations,
    catch: toOrganizationError,
  });
  if (Result.isError(organizations)) {
    return organizations;
  }
  const existing = organizations.value.find(
    ({ slug }) => slug === identity.organizationSlug,
  );
  if (existing) {
    return Result.ok(existing.id);
  }

  const created = await Result.tryPromise({
    try: async () => createOrganization(identity),
    catch: toOrganizationError,
  });
  if (Result.isOk(created)) {
    return created;
  }

  // A competing create or a lost response can leave the exact org already owned.
  const relisted = await Result.tryPromise({
    try: listOrganizations,
    catch: toOrganizationError,
  });
  if (Result.isError(relisted)) {
    return relisted;
  }
  const recovered = relisted.value.find(
    ({ slug }) => slug === identity.organizationSlug,
  );
  if (recovered) {
    return Result.ok(recovered.id);
  }
  return created;
};

const DEV_QUICK_START_EMAIL = "dev-quick-start@stella.dev";

export const createDevQuickStartIdentity = (
  randomId: string,
): DevQuickStartIdentity => {
  const compactId = randomId.replaceAll("-", "").toLowerCase();
  const label = compactId.slice(-8);
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
  startMatterImport: (
    identity: DevQuickStartIdentity,
    organizationId: string,
  ) => Promise<void>;
};

const PHASE_ORDER = {
  [DEV_QUICK_START_PHASE.authenticate]: 0,
  [DEV_QUICK_START_PHASE.organization]: 1,
  [DEV_QUICK_START_PHASE.matters]: 2,
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
  startMatterImport,
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
    shouldRunPhase(currentAttempt.completedPhase, DEV_QUICK_START_PHASE.matters)
  ) {
    onPhase(DEV_QUICK_START_PHASE.matters);
    await startMatterImport(currentAttempt.identity, organizationId);
    completePhase(DEV_QUICK_START_PHASE.matters);
  }
};
