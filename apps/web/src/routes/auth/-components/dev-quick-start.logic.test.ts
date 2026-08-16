import { describe, expect, test } from "bun:test";

import {
  createDevQuickStartIdentity,
  DEV_QUICK_START_PHASE,
  type DevQuickStartPhase,
  runDevQuickStart,
} from "./dev-quick-start.logic";

const RANDOM_ID = "018f1f7e-89ab-7def-8123-456789abcdef";

describe("createDevQuickStartIdentity", () => {
  test("reuses the local account with a unique org and reproducible seed", () => {
    expect(createDevQuickStartIdentity(RANDOM_ID)).toEqual({
      email: "dev-quick-start@stella.dev",
      organizationName: "Harvey LAB 018F1F7E",
      organizationSlug: "dev-quick-start-018f1f7e89ab7def8123456789abcdef",
      selectionSeed: RANDOM_ID,
    });
  });
});

describe("runDevQuickStart", () => {
  test("authenticates and establishes ownership before either seed", async () => {
    const calls: string[] = [];
    const identity = createDevQuickStartIdentity(RANDOM_ID);

    await runDevQuickStart({
      attempt: { completedPhase: null, identity },
      authenticate: async () => {
        calls.push("authenticate");
      },
      createOrganization: async () => {
        calls.push("organization");
      },
      onPhase: (phase) => {
        calls.push(`phase:${phase}`);
      },
      onPhaseCompleted: (phase) => {
        calls.push(`completed:${phase}`);
      },
      seedMatters: async () => {
        calls.push("matters");
      },
      seedSkills: async () => {
        calls.push("skills");
      },
    });

    expect(calls).toEqual([
      `phase:${DEV_QUICK_START_PHASE.authenticate}`,
      "authenticate",
      `completed:${DEV_QUICK_START_PHASE.authenticate}`,
      `phase:${DEV_QUICK_START_PHASE.organization}`,
      "organization",
      `completed:${DEV_QUICK_START_PHASE.organization}`,
      `phase:${DEV_QUICK_START_PHASE.skills}`,
      "skills",
      `completed:${DEV_QUICK_START_PHASE.skills}`,
      `phase:${DEV_QUICK_START_PHASE.matters}`,
      "matters",
      `completed:${DEV_QUICK_START_PHASE.matters}`,
    ]);
  });

  test("fails fast before organization-scoped seeds", async () => {
    const calls: string[] = [];
    const identity = createDevQuickStartIdentity(RANDOM_ID);

    expect(
      runDevQuickStart({
        attempt: { completedPhase: null, identity },
        authenticate: async () => {
          calls.push("authenticate");
        },
        createOrganization: async () => {
          calls.push("organization");
          throw new Error("organization failed");
        },
        onPhase: () => undefined,
        onPhaseCompleted: () => undefined,
        seedMatters: async () => {
          calls.push("matters");
        },
        seedSkills: async () => {
          calls.push("skills");
        },
      }),
    ).rejects.toThrow("organization failed");
    expect(calls).toEqual(["authenticate", "organization"]);
  });

  test("resumes after the last completed phase with the same identity", async () => {
    const calls: string[] = [];
    const identity = createDevQuickStartIdentity(RANDOM_ID);
    const progress: { completedPhase: DevQuickStartPhase | null } = {
      completedPhase: null,
    };
    let matterAttempts = 0;

    const run = async () =>
      runDevQuickStart({
        attempt: { completedPhase: progress.completedPhase, identity },
        authenticate: async () => {
          calls.push("authenticate");
        },
        createOrganization: async () => {
          calls.push("organization");
        },
        onPhase: () => undefined,
        onPhaseCompleted: (phase) => {
          progress.completedPhase = phase;
        },
        seedMatters: async (attemptIdentity) => {
          expect(attemptIdentity).toBe(identity);
          matterAttempts += 1;
          calls.push("matters");
          if (matterAttempts === 1) {
            throw new Error("import failed");
          }
        },
        seedSkills: async () => {
          calls.push("skills");
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
      "skills",
      "matters",
      "matters",
    ]);
    expect(progress.completedPhase).toBe(DEV_QUICK_START_PHASE.matters);
  });
});
