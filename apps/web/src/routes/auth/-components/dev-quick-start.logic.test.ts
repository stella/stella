import { describe, expect, test } from "bun:test";

import {
  createDevQuickStartIdentity,
  DEV_QUICK_START_PHASE,
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

    await runDevQuickStart({
      authenticate: async () => {
        calls.push("authenticate");
      },
      createOrganization: async () => {
        calls.push("organization");
      },
      onPhase: (phase) => {
        calls.push(`phase:${phase}`);
      },
      randomId: RANDOM_ID,
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
      `phase:${DEV_QUICK_START_PHASE.organization}`,
      "organization",
      `phase:${DEV_QUICK_START_PHASE.skills}`,
      "skills",
      `phase:${DEV_QUICK_START_PHASE.matters}`,
      "matters",
    ]);
  });

  test("fails fast before organization-scoped seeds", async () => {
    const calls: string[] = [];

    expect(
      runDevQuickStart({
        authenticate: async () => {
          calls.push("authenticate");
        },
        createOrganization: async () => {
          calls.push("organization");
          throw new Error("organization failed");
        },
        onPhase: () => undefined,
        randomId: RANDOM_ID,
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
});
