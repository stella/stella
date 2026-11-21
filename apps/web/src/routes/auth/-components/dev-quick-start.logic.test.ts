import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  createDevQuickStartIdentity,
  createDevQuickStartRuntime,
  DEV_QUICK_START_PHASE,
  DEV_QUICK_START_STAGE,
  type DevQuickStartAttempt,
  type DevQuickStartPhase,
  resolveDevQuickStartOrganization,
  runDevQuickStart,
  startDevQuickStartAttempt,
} from "./dev-quick-start.logic";

const RANDOM_ID = "018f1f7e-89ab-7def-8123-456789abcdef";
const ORGANIZATION_ID = "organization-quick-start";

describe("createDevQuickStartIdentity", () => {
  test("reuses the local account with a unique org and reproducible seed", () => {
    expect(createDevQuickStartIdentity(RANDOM_ID)).toEqual({
      email: "dev-quick-start@stella.dev",
      organizationName: "Harvey LAB 89ABCDEF",
      organizationSlug: "dev-quick-start-018f1f7e89ab7def8123456789abcdef",
      selectionSeed: RANDOM_ID,
    });
  });
});

describe("quick-start run ownership", () => {
  test("an explicit start replaces a stored or cached completed attempt with a new org and seed", async () => {
    const completedAttempt = {
      completedPhase: DEV_QUICK_START_PHASE.matters,
      identity: createDevQuickStartIdentity(RANDOM_ID),
      organizationId: ORGANIZATION_ID,
    } satisfies DevQuickStartAttempt;
    const nextIdentity = createDevQuickStartIdentity(
      "118f1f7e-89ab-7def-8123-456789abcdef",
    );
    expect(nextIdentity.organizationSlug).not.toBe(
      completedAttempt.identity.organizationSlug,
    );
    expect(nextIdentity.selectionSeed).not.toBe(
      completedAttempt.identity.selectionSeed,
    );

    for (const source of ["stored", "cached"] as const) {
      const runtime = createDevQuickStartRuntime();
      if (source === "cached") {
        runtime.setAttempt(completedAttempt);
      }
      let generatedIdentities = 0;
      const freshAttempt = startDevQuickStartAttempt(
        runtime.getAttempt(() => completedAttempt),
        () => {
          generatedIdentities += 1;
          return nextIdentity;
        },
      );
      runtime.setAttempt(freshAttempt);
      expect(freshAttempt).toEqual({
        completedPhase: null,
        identity: nextIdentity,
        organizationId: null,
      });
      expect(freshAttempt.identity.email).toBe(completedAttempt.identity.email);
      expect(generatedIdentities).toBe(1);

      const calls: string[] = [];
      await runDevQuickStart({
        attempt: freshAttempt,
        authenticate: async (identity) => {
          expect(identity).toBe(nextIdentity);
          calls.push("authenticate");
        },
        createOrganization: async (identity) => {
          expect(identity).toBe(nextIdentity);
          calls.push("organization");
          return "fresh-organization";
        },
        onAttemptUpdated: runtime.setAttempt,
        onPhase: runtime.setPhase,
        startMatterImport: async ({ selectionSeed }, organizationId) => {
          expect(selectionSeed).toBe(nextIdentity.selectionSeed);
          expect(organizationId).toBe("fresh-organization");
          calls.push("matters");
        },
      });
      expect(calls).toEqual(["authenticate", "organization", "matters"]);
      expect(runtime.getAttempt(() => completedAttempt)).toEqual({
        completedPhase: DEV_QUICK_START_PHASE.matters,
        identity: nextIdentity,
        organizationId: "fresh-organization",
      });
    }
  });

  test("an explicit start resumes every unfinished phase without generating another identity", () => {
    for (const completedPhase of [
      null,
      DEV_QUICK_START_PHASE.authenticate,
      DEV_QUICK_START_PHASE.organization,
    ]) {
      const attempt = {
        completedPhase,
        identity: createDevQuickStartIdentity(RANDOM_ID),
        organizationId:
          completedPhase === DEV_QUICK_START_PHASE.organization
            ? ORGANIZATION_ID
            : null,
      } satisfies DevQuickStartAttempt;
      let generatedIdentities = 0;
      const resumed = startDevQuickStartAttempt(attempt, () => {
        generatedIdentities += 1;
        return createDevQuickStartIdentity("unexpected-identity");
      });

      expect(resumed).toBe(attempt);
      expect(generatedIdentities).toBe(0);
    }
  });

  test("shares one flight and its progress across concurrent continuation starts", async () => {
    const runtime = createDevQuickStartRuntime();
    const blockedImport = Promise.withResolvers<undefined>();
    const importStarted = Promise.withResolvers<undefined>();
    const calls: string[] = [];
    const initialAttempt = {
      completedPhase: DEV_QUICK_START_PHASE.authenticate,
      identity: createDevQuickStartIdentity(RANDOM_ID),
      organizationId: null,
    } satisfies DevQuickStartAttempt;
    const run = async () =>
      runDevQuickStart({
        attempt: runtime.getAttempt(() => initialAttempt),
        authenticate: async () => {
          calls.push("authenticate");
        },
        createOrganization: async () => {
          calls.push("organization");
          return ORGANIZATION_ID;
        },
        onAttemptUpdated: runtime.setAttempt,
        onPhase: runtime.setPhase,
        startMatterImport: async () => {
          calls.push("matters");
          importStarted.resolve(undefined);
          await blockedImport.promise;
        },
      });
    const first = runtime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.continue,
      run,
    });
    const second = runtime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.continue,
      run,
    });
    await importStarted.promise;

    // A remount joins after organization setup and observes the active phase.
    const phases: (DevQuickStartPhase | null)[] = [runtime.getPhase()];
    const unsubscribe = runtime.subscribe(() => {
      phases.push(runtime.getPhase());
    });
    const remounted = runtime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.continue,
      run,
    });
    let completedCallers = 0;
    const callers = [first, second, remounted].map(async (promise) => {
      await promise;
      completedCallers += 1;
    });
    await Promise.resolve();
    expect(completedCallers).toBe(0);
    blockedImport.resolve(undefined);
    await Promise.all(callers);
    expect(completedCallers).toBe(3);
    unsubscribe();

    expect(calls).toEqual(["organization", "matters"]);
    expect(phases).toEqual([DEV_QUICK_START_PHASE.matters, null]);
    expect(runtime.getAttempt(() => initialAttempt)).toEqual({
      completedPhase: DEV_QUICK_START_PHASE.matters,
      identity: initialAttempt.identity,
      organizationId: ORGANIZATION_ID,
    });
  });

  test("serializes a mounted continuation behind sign-in and coalesces queued mounts", async () => {
    const runtime = createDevQuickStartRuntime();
    const signedIn = Promise.withResolvers<undefined>();
    const calls: string[] = [];
    const authentication = runtime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.authenticate,
      run: async () => {
        calls.push("authenticate");
        await signedIn.promise;
        calls.push("authenticated");
      },
    });
    const continueRun = async () => {
      calls.push("continue");
    };
    const continuation = runtime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.continue,
      run: continueRun,
    });
    const remounted = runtime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.continue,
      run: continueRun,
    });
    signedIn.resolve(undefined);
    await Promise.all([authentication, continuation, remounted]);

    expect(calls).toEqual(["authenticate", "authenticated", "continue"]);
  });

  test("retains a completed attempt when persistence is cleared before navigation", async () => {
    const runtime = createDevQuickStartRuntime();
    const initialAttempt = {
      completedPhase: DEV_QUICK_START_PHASE.authenticate,
      identity: createDevQuickStartIdentity(RANDOM_ID),
      organizationId: null,
    } satisfies DevQuickStartAttempt;
    let savedAttempt: DevQuickStartAttempt | null = initialAttempt;
    let restores = 0;
    const calls: string[] = [];
    const run = async () =>
      runDevQuickStart({
        attempt: runtime.getAttempt(() => {
          restores += 1;
          return (
            savedAttempt ?? {
              completedPhase: DEV_QUICK_START_PHASE.authenticate,
              identity: createDevQuickStartIdentity("new-identity"),
              organizationId: null,
            }
          );
        }),
        authenticate: async () => undefined,
        createOrganization: async () => {
          calls.push("organization");
          return ORGANIZATION_ID;
        },
        onAttemptUpdated: (attempt) => {
          runtime.setAttempt(attempt);
          savedAttempt = attempt;
        },
        onPhase: runtime.setPhase,
        startMatterImport: async () => {
          calls.push("matters");
        },
      });

    await runtime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.continue,
      run,
    });
    savedAttempt = null;
    await runtime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.continue,
      run,
    });

    expect(restores).toBe(1);
    expect(calls).toEqual(["organization", "matters"]);
    expect(runtime.getAttempt(() => initialAttempt).identity).toBe(
      initialAttempt.identity,
    );
  });

  test("retries a lost import response with the same organization and seed to attach to the running job", async () => {
    const runtime = createDevQuickStartRuntime();
    const initialAttempt = {
      completedPhase: DEV_QUICK_START_PHASE.authenticate,
      identity: createDevQuickStartIdentity(RANDOM_ID),
      organizationId: null,
    } satisfies DevQuickStartAttempt;
    const startedJobs = new Map<
      string,
      { organizationId: string; selectionSeed: string }
    >();
    let importRequests = 0;
    let organizationCreates = 0;
    const run = async () =>
      runDevQuickStart({
        attempt: runtime.getAttempt(() => initialAttempt),
        authenticate: async () => undefined,
        createOrganization: async () => {
          organizationCreates += 1;
          return ORGANIZATION_ID;
        },
        onAttemptUpdated: runtime.setAttempt,
        onPhase: runtime.setPhase,
        startMatterImport: async ({ selectionSeed }, organizationId) => {
          importRequests += 1;
          const request = { organizationId, selectionSeed };
          const running = startedJobs.get("job-1");
          if (running) {
            expect(request).toEqual(running);
            return;
          }
          startedJobs.set("job-1", request);
          throw new Error("import response lost");
        },
      });

    const result = await Result.tryPromise(async () =>
      runtime.runSingleFlight({
        stage: DEV_QUICK_START_STAGE.continue,
        run,
      }),
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.cause).toEqual(new Error("import response lost"));
    }
    expect(runtime.getPhase()).toBeNull();
    await runtime.runSingleFlight({
      stage: DEV_QUICK_START_STAGE.continue,
      run,
    });

    expect(importRequests).toBe(2);
    expect(organizationCreates).toBe(1);
    expect(startedJobs.size).toBe(1);
    expect(startedJobs.get("job-1")).toEqual({
      organizationId: ORGANIZATION_ID,
      selectionSeed: RANDOM_ID,
    });
    expect(runtime.getAttempt(() => initialAttempt).completedPhase).toBe(
      DEV_QUICK_START_PHASE.matters,
    );
  });
});

describe("quick-start organization recovery", () => {
  test("uses an existing organization without creating another", async () => {
    const identity = createDevQuickStartIdentity(RANDOM_ID);
    let creates = 0;
    const organizationId = await resolveDevQuickStartOrganization({
      identity,
      listOrganizations: async () => [
        { id: ORGANIZATION_ID, slug: identity.organizationSlug },
      ],
      createOrganization: async () => {
        creates += 1;
        return "unexpected-organization";
      },
    });
    expect(organizationId).toEqual(Result.ok(ORGANIZATION_ID));
    expect(creates).toBe(0);
  });

  test("re-lists and reuses the exact slug after a competing organization create", async () => {
    const identity = createDevQuickStartIdentity(RANDOM_ID);
    let listed = 0;
    const organizationId = await resolveDevQuickStartOrganization({
      identity,
      listOrganizations: async () => {
        listed += 1;
        return listed === 1
          ? []
          : [
              { id: "unrelated-organization", slug: "unrelated-slug" },
              { id: ORGANIZATION_ID, slug: identity.organizationSlug },
            ];
      },
      createOrganization: async () => {
        throw new Error("duplicate organization slug");
      },
    });
    expect(organizationId).toEqual(Result.ok(ORGANIZATION_ID));
    expect(listed).toBe(2);
  });

  test("propagates a create failure when the attempt's organization does not exist", async () => {
    const failure = new Error("organization create failed");
    const result = await resolveDevQuickStartOrganization({
      identity: createDevQuickStartIdentity(RANDOM_ID),
      listOrganizations: async () => [
        { id: "unrelated-organization", slug: "unrelated-slug" },
      ],
      createOrganization: async () => {
        throw failure;
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.cause).toBe(failure);
    }
  });

  test("returns a typed failure when listing organizations fails", async () => {
    const failure = new Error("organization list failed");
    let creates = 0;
    const result = await resolveDevQuickStartOrganization({
      identity: createDevQuickStartIdentity(RANDOM_ID),
      listOrganizations: async () => {
        throw failure;
      },
      createOrganization: async () => {
        creates += 1;
        return ORGANIZATION_ID;
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.cause).toBe(failure);
    }
    expect(creates).toBe(0);
  });
});

describe("runDevQuickStart", () => {
  test("authenticates and establishes ownership before either seed", async () => {
    const calls: string[] = [];
    const identity = createDevQuickStartIdentity(RANDOM_ID);

    await runDevQuickStart({
      attempt: { completedPhase: null, identity, organizationId: null },
      authenticate: async () => {
        calls.push("authenticate");
      },
      createOrganization: async () => {
        calls.push("organization");
        return ORGANIZATION_ID;
      },
      onAttemptUpdated: ({ completedPhase }) => {
        calls.push(`completed:${completedPhase ?? "none"}`);
      },
      onPhase: (phase) => {
        calls.push(`phase:${phase}`);
      },
      startMatterImport: async (_identity, organizationId) => {
        expect(organizationId).toBe(ORGANIZATION_ID);
        calls.push("matters");
      },
    });

    expect(calls).toEqual([
      `phase:${DEV_QUICK_START_PHASE.authenticate}`,
      "authenticate",
      `completed:${DEV_QUICK_START_PHASE.authenticate}`,
      `phase:${DEV_QUICK_START_PHASE.organization}`,
      "organization",
      `completed:${DEV_QUICK_START_PHASE.organization}`,
      `phase:${DEV_QUICK_START_PHASE.matters}`,
      "matters",
      `completed:${DEV_QUICK_START_PHASE.matters}`,
    ]);
  });

  test("fails fast before organization-scoped seeds", async () => {
    const calls: string[] = [];
    const identity = createDevQuickStartIdentity(RANDOM_ID);

    const result = await Result.tryPromise(async () =>
      runDevQuickStart({
        attempt: { completedPhase: null, identity, organizationId: null },
        authenticate: async () => {
          calls.push("authenticate");
        },
        createOrganization: async () => {
          calls.push("organization");
          throw new Error("organization failed");
        },
        onAttemptUpdated: () => undefined,
        onPhase: () => undefined,
        startMatterImport: async () => {
          calls.push("matters");
        },
      }),
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.cause).toEqual(new Error("organization failed"));
    }
    expect(calls).toEqual(["authenticate", "organization"]);
  });

  test("resumes after the last completed phase with the same identity", async () => {
    const calls: string[] = [];
    const identity = createDevQuickStartIdentity(RANDOM_ID);
    let progress: {
      completedPhase: DevQuickStartPhase | null;
      organizationId: string | null;
    } = {
      completedPhase: null,
      organizationId: null,
    };
    let matterAttempts = 0;

    const run = async () =>
      runDevQuickStart({
        attempt: { ...progress, identity },
        authenticate: async () => {
          calls.push("authenticate");
        },
        createOrganization: async () => {
          calls.push("organization");
          return ORGANIZATION_ID;
        },
        onAttemptUpdated: ({ completedPhase, organizationId }) => {
          progress = { completedPhase, organizationId };
        },
        onPhase: () => undefined,
        startMatterImport: async (attemptIdentity, organizationId) => {
          expect(attemptIdentity).toBe(identity);
          expect(organizationId).toBe(ORGANIZATION_ID);
          matterAttempts += 1;
          calls.push("matters");
          if (matterAttempts === 1) {
            throw new Error("import failed");
          }
        },
      });

    const firstRun = await run().then(
      () => ({ status: "succeeded" }) as const,
      (error: unknown) =>
        ({
          message: error instanceof Error ? error.message : "Unknown error",
          status: "failed",
        }) as const,
    );
    expect(firstRun).toEqual({ message: "import failed", status: "failed" });
    await run();
    await run();

    expect(calls).toEqual([
      "authenticate",
      "organization",
      "matters",
      "matters",
    ]);
    expect(progress.completedPhase).toBe(DEV_QUICK_START_PHASE.matters);
    expect(progress.organizationId).toBe(ORGANIZATION_ID);
  });

  test("pins resumed seeds to the organization stored by the attempt", async () => {
    const identity = createDevQuickStartIdentity(RANDOM_ID);
    const seededOrganizations: string[] = [];

    await runDevQuickStart({
      attempt: {
        completedPhase: DEV_QUICK_START_PHASE.organization,
        identity,
        organizationId: ORGANIZATION_ID,
      },
      authenticate: async () => undefined,
      createOrganization: async () => "unexpected-organization",
      onAttemptUpdated: () => undefined,
      onPhase: () => undefined,
      startMatterImport: async (_identity, organizationId) => {
        seededOrganizations.push(organizationId);
      },
    });

    expect(seededOrganizations).toEqual([ORGANIZATION_ID]);
  });
});
