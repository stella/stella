import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  type Advisory,
  AuditCommandError,
  type Baseline,
  BaselineError,
  check,
  checkRelease,
  collectGatedAdvisories,
  readBaseline,
  runDependencyAuditCli,
} from "./dependency-audit";
import {
  expiringAcceptances,
  lapsedAcceptances,
} from "./dependency-audit-acceptance";

const advisory = { id: "GHSA-aaaa-bbbb-cccc", vulnerableVersions: "<=1.4.0" };
const latest = (version: string | undefined) => () => version;
const currentAdvisory: Advisory = {
  ...advisory,
  severity: "high",
  package: "pkg",
  title: "test advisory",
};
const auditBaseline = (expiresOn?: string): Baseline => ({
  note: "test",
  auditLevel: "high",
  accepted: [
    {
      id: advisory.id,
      severity: "high",
      package: "pkg",
      title: "test advisory",
      owner: "test owner",
      reason: "test acceptance",
      ...(expiresOn === undefined ? {} : { expiresOn }),
    },
  ],
});

const runCheck = async (
  advisories: Advisory[],
  accepted: Baseline,
  today: string,
  warningFormat: "github" | "plain" = "plain",
) => {
  const output: { info: string[]; warn: string[] } = { info: [], warn: [] };
  const info = spyOn(console, "info").mockImplementation((message) => {
    output.info.push(String(message));
  });
  const warn = spyOn(console, "warn").mockImplementation((message) => {
    output.warn.push(String(message));
  });
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const status = await check(advisories, {
      baseline: accepted,
      now: () => new Date(`${today}T00:00:00Z`),
      warningFormat,
    });
    return { ...output, status };
  } finally {
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
};

const runReleaseCheck = async (
  advisories: Advisory[],
  baseline: Baseline,
  today = "2026-10-02",
) => {
  const output: { error: string[]; warn: string[] } = { error: [], warn: [] };
  const info = spyOn(console, "info").mockImplementation(() => undefined);
  const warn = spyOn(console, "warn").mockImplementation((message) => {
    output.warn.push(String(message));
  });
  const error = spyOn(console, "error").mockImplementation((message) => {
    output.error.push(String(message));
  });
  try {
    const status = await checkRelease(advisories, {
      baseline,
      latestVersion: async () => "1.4.0",
      now: () => new Date(`${today}T00:00:00Z`),
      warningFormat: "plain",
    });
    return { ...output, status };
  } finally {
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
};

describe("release audit acceptance", () => {
  test("unexpired baselined advisories pass with one release warning each", async () => {
    const second = {
      ...currentAdvisory,
      id: "GHSA-dddd-eeee-ffff",
      package: "second-pkg",
    };
    const baseline = auditBaseline("2026-11-01");
    baseline.accepted.push({
      ...baseline.accepted[0]!,
      id: second.id,
      package: second.package,
    });
    const result = await runReleaseCheck([currentAdvisory, second], baseline);

    expect(result.status).toBe(0);
    expect(
      result.warn.filter((line) =>
        line.startsWith(
          "::warning title=Release dependency audit accepted advisory::",
        ),
      ),
    ).toHaveLength(2);
    expect(result.warn.join("\n")).toContain(
      "GHSA-aaaa-bbbb-cccc for pkg is accepted by test owner until 2026-11-01",
    );
  });

  test("a new advisory fails", async () => {
    const result = await runReleaseCheck([currentAdvisory], {
      ...auditBaseline("2026-11-01"),
      accepted: [],
    });
    expect(result.status).toBe(1);
  });

  test("an expired acceptance fails", async () => {
    const result = await runReleaseCheck(
      [currentAdvisory],
      auditBaseline("2026-10-01"),
    );
    expect(result.status).toBe(2);
    expect(result.error.join("\n")).toContain(advisory.id);
  });

  test("an untilPatched-only acceptance fails naming the advisory", async () => {
    const baseline = auditBaseline();
    baseline.accepted[0]!.untilPatched = true;
    const result = await runReleaseCheck([currentAdvisory], baseline);
    expect(result.status).toBe(2);
    expect(result.error.join("\n")).toContain(advisory.id);
    expect(result.error.join("\n")).toContain("must have expiresOn");
  });

  test("a placeholder owner fails naming the advisory", async () => {
    const baseline = auditBaseline("2026-11-01");
    baseline.accepted[0]!.owner = "TODO: owner";
    const result = await runReleaseCheck([currentAdvisory], baseline);
    expect(result.status).toBe(2);
    expect(result.error.join("\n")).toContain(advisory.id);
    expect(result.error.join("\n")).toContain("non-placeholder owner");
  });
});

describe("audit acceptance expiry", () => {
  test("an accepted advisory is reported without failing", async () => {
    const result = await runCheck(
      [currentAdvisory],
      auditBaseline("2026-11-01"),
      "2026-10-02",
    );
    expect(result.status).toBe(0);
    expect(
      result.info.some((line) => line.includes("accepted until 2026-11-01")),
    ).toBe(true);
    expect(result.info.some((line) => line.includes("owner: test owner"))).toBe(
      true,
    );
  });

  test("a new advisory is reported and fails", async () => {
    const newBaseline = { ...auditBaseline(), accepted: [] };
    const newResult = await runCheck(
      [currentAdvisory],
      newBaseline,
      "2026-10-02",
    );
    expect(newResult.status).toBe(1);
    expect(newResult.info.some((line) => line.endsWith("NEW"))).toBe(true);
  });

  test("an acceptance expiring in three days warns", async () => {
    const result = await runCheck(
      [currentAdvisory],
      auditBaseline("2026-10-05"),
      "2026-10-02",
    );
    expect(result.status).toBe(0);
    expect(result.warn).toEqual([
      "WARNING: GHSA-aaaa-bbbb-cccc for pkg is accepted until 2026-10-05; review or remediate it before expiry.",
    ]);
  });

  test("an expiring acceptance warns as a GitHub annotation in Actions output", async () => {
    const result = await runCheck(
      [currentAdvisory],
      auditBaseline("2026-10-05"),
      "2026-10-02",
      "github",
    );
    expect(result.status).toBe(0);
    expect(result.warn).toEqual([
      "::warning title=Dependency audit acceptance expiring::GHSA-aaaa-bbbb-cccc for pkg is accepted until 2026-10-05; review or remediate it before expiry.",
    ]);
  });

  test("an acceptance expiring in ten days does not warn", () => {
    expect(
      expiringAcceptances({
        accepted: auditBaseline("2026-10-12").accepted,
        current: [advisory],
        today: "2026-10-02",
      }),
    ).toEqual([]);
  });

  test("an expired acceptance fails", async () => {
    const result = await runCheck(
      [currentAdvisory],
      auditBaseline("2026-10-01"),
      "2026-10-02",
    );
    expect(result.status).toBe(2);
    expect(result.info.some((line) => line.endsWith("LAPSED"))).toBe(true);
  });

  test("an acceptance without terms never lapses", () => {
    expect(
      lapsedAcceptances({
        accepted: [{ id: advisory.id, package: "pkg" }],
        current: [advisory],
        today: "2099-01-01",
        latestVersion: latest(undefined),
      }),
    ).toEqual([]);
  });

  test("an acceptance lapses after its expiry date, not on it", () => {
    const accepted = [
      { id: advisory.id, package: "pkg", expiresOn: "2026-11-01" },
    ];
    for (const today of ["2026-10-02", "2026-11-01"]) {
      expect(
        lapsedAcceptances({
          accepted,
          current: [advisory],
          today,
          latestVersion: latest("1.4.0"),
        }),
      ).toEqual([]);
    }
    expect(
      lapsedAcceptances({
        accepted,
        current: [advisory],
        today: "2026-11-02",
        latestVersion: latest("1.4.0"),
      }).map(({ reason }) => reason),
    ).toEqual(["the acceptance expired on 2026-11-01"]);
  });

  test("a malformed or impossible expiry date fails closed", () => {
    for (const expiresOn of ["1 Nov 2026", "2026-13-45", "2026-02-30", ""]) {
      expect(
        lapsedAcceptances({
          accepted: [{ id: advisory.id, package: "pkg", expiresOn }],
          current: [advisory],
          today: "2026-10-02",
          latestVersion: latest("1.4.0"),
        }),
        expiresOn,
      ).toHaveLength(1);
    }
    expect(
      lapsedAcceptances({
        accepted: [
          { id: advisory.id, package: "pkg", expiresOn: "2028-02-29" },
        ],
        current: [advisory],
        today: "2026-10-02",
        latestVersion: latest("1.4.0"),
      }),
    ).toEqual([]);
  });

  test("a non-boolean untilPatched fails closed", () => {
    for (const untilPatched of ["true", 1, null]) {
      expect(
        lapsedAcceptances({
          accepted: [{ id: advisory.id, package: "pkg", untilPatched }],
          current: [advisory],
          today: "2026-10-02",
          latestVersion: latest("1.4.0"),
        }).map(({ reason }) => reason),
      ).toEqual(["untilPatched must be true or false"]);
    }
  });

  test("untilPatched lapses once the latest release is outside the vulnerable range", () => {
    const accepted = [{ id: advisory.id, package: "pkg", untilPatched: true }];
    expect(
      lapsedAcceptances({
        accepted,
        current: [advisory],
        today: "2026-10-02",
        latestVersion: latest("1.4.0"),
      }),
    ).toEqual([]);
    const lapsed = lapsedAcceptances({
      accepted,
      current: [advisory],
      today: "2026-10-02",
      latestVersion: latest("1.4.1"),
    });
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]?.reason).toContain("a patched release exists");
  });

  test("untilPatched fails closed when the lookup or the range is missing", () => {
    const accepted = [{ id: advisory.id, package: "pkg", untilPatched: true }];
    expect(
      lapsedAcceptances({
        accepted,
        current: [advisory],
        today: "2026-10-02",
        latestVersion: latest(undefined),
      }),
    ).toHaveLength(1);
    expect(
      lapsedAcceptances({
        accepted,
        current: [{ id: advisory.id, vulnerableVersions: "" }],
        today: "2026-10-02",
        latestVersion: latest("1.4.0"),
      }),
    ).toHaveLength(1);
  });

  test("a temporary acceptance lapses once its advisory is no longer reported", () => {
    for (const terms of [{ untilPatched: true }, { expiresOn: "2026-11-01" }]) {
      expect(
        lapsedAcceptances({
          accepted: [{ id: advisory.id, package: "pkg", ...terms }],
          current: [],
          today: "2026-10-02",
          latestVersion: latest("1.4.0"),
        }).map(({ reason }) => reason),
      ).toEqual(["the advisory is no longer reported; remove the acceptance"]);
    }
    expect(
      lapsedAcceptances({
        accepted: [{ id: advisory.id, package: "pkg" }],
        current: [],
        today: "2026-10-02",
        latestVersion: latest("1.4.0"),
      }),
    ).toEqual([]);
  });

  test("every committed untilPatched acceptance also has an expiry date", async () => {
    // untilPatched lapses through a registry lookup; the date makes sure an
    // acceptance still ends if no fix is ever published.
    const baseline: unknown = await Bun.file(
      new URL("dependency-audit-baseline.json", import.meta.url),
    ).json();
    const accepted =
      typeof baseline === "object" &&
      baseline !== null &&
      "accepted" in baseline &&
      Array.isArray(baseline.accepted)
        ? baseline.accepted
        : [];
    const temporary = accepted.filter(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "untilPatched" in entry &&
        entry.untilPatched === true,
    );
    expect(temporary.length).toBeGreaterThan(0);
    for (const entry of temporary) {
      const expiresOn =
        typeof entry === "object" && entry !== null && "expiresOn" in entry
          ? entry.expiresOn
          : undefined;
      expect(typeof expiresOn === "string" ? expiresOn : "").toMatch(
        /^\d{4}-\d{2}-\d{2}$/u,
      );
    }
  });

  test.each([
    {
      field: "owner",
      owner: "  TODO: owner",
      reason: "test acceptance",
    },
    {
      field: "owner",
      owner: " TODO_owner",
      reason: "test acceptance",
    },
    {
      field: "reason",
      owner: "test owner",
      reason: "todo: document why this is accepted.",
    },
    {
      field: "reason",
      owner: "test owner",
      reason: "todoreason",
    },
  ])(
    "a baseline entry with a placeholder $field fails closed",
    async (entry) => {
      const temporary = mkdtempSync(path.join(tmpdir(), "dependency-audit-"));
      const baselinePath = path.join(temporary, "baseline.json");
      await Bun.write(
        baselinePath,
        JSON.stringify({
          note: "test",
          auditLevel: "high",
          accepted: [
            {
              id: advisory.id,
              severity: "high",
              package: "pkg",
              title: "test advisory",
              owner: entry.owner,
              reason: entry.reason,
            },
          ],
        }),
      );
      try {
        expect(await rejectionOf(readBaseline(baselinePath))).toHaveProperty(
          "message",
          expect.stringContaining(
            `${advisory.id} must have a non-placeholder ${entry.field}`,
          ),
        );
      } finally {
        rmSync(temporary, { force: true, recursive: true });
      }
    },
  );

  test("a baseline entry with a real owner and reason is accepted", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "dependency-audit-"));
    const baselinePath = path.join(temporary, "baseline.json");
    const baseline = auditBaseline();
    await Bun.write(baselinePath, JSON.stringify(baseline));
    try {
      expect(await readBaseline(baselinePath)).toEqual(baseline);
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });
});

const auditJson = JSON.stringify({
  advisories: {
    pkg: [
      {
        github_advisory_id: advisory.id,
        severity: "high",
        title: "test advisory",
        vulnerable_versions: "<=1.4.0",
      },
    ],
  },
});

describe("advisory service retries", () => {
  test("a 503 followed by success returns advisories", async () => {
    const results = [
      { exitCode: 1, stderr: "POST advisory bulk - 503", stdout: "" },
      { exitCode: 0, stderr: "", stdout: auditJson },
    ];
    const delays: number[] = [];
    const advisories = await collectGatedAdvisories({
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      run: async () => results.shift() ?? panicUnexpectedAttempt(),
    });
    expect(advisories).toEqual([currentAdvisory]);
    expect(delays).toEqual([10_000]);
  });

  test("three 503 responses raise the final audit error", async () => {
    let attempts = 0;
    expect(
      await rejectionOf(
        collectGatedAdvisories({
          delay: async () => undefined,
          run: async () => {
            attempts += 1;
            return {
              exitCode: 1,
              stderr: "POST advisory bulk - 503",
              stdout: "",
            };
          },
        }),
      ),
    ).toBeInstanceOf(AuditCommandError);
    expect(attempts).toBe(3);
  });

  test("non-transient failures do not retry", async () => {
    for (const result of [
      { exitCode: 0, stderr: "", stdout: "not JSON" },
      { exitCode: 1, stderr: "permission denied", stdout: "" },
    ]) {
      let attempts = 0;
      expect(
        await rejectionOf(
          collectGatedAdvisories({
            delay: async () => undefined,
            run: async () => {
              attempts += 1;
              return result;
            },
          }),
        ),
      ).toBeInstanceOf(AuditCommandError);
      expect(attempts).toBe(1);
    }
  });
});

describe("CLI exit codes", () => {
  test.each([
    { error: new BaselineError("invalid baseline"), status: 2 },
    { error: new AuditCommandError("audit failed"), status: 3 },
    { error: new Error("unexpected failure"), status: 4 },
  ])("maps $error.name to exit $status", async ({ error, status }) => {
    expect(
      await runDependencyAuditCli(async () => {
        throw error;
      }),
    ).toBe(status);
  });
});

const panicUnexpectedAttempt = (): never => {
  throw new Error("unexpected extra audit attempt");
};
