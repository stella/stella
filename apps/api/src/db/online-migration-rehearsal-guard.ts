import { panic } from "better-result";

import type { OnlineRepair } from "./online-migration-connection";

export type OnlineRepairRehearsalRecord = {
  name: string;
  precondition: "empty" | "non-empty";
};

export const assertOnlineRepairRehearsalCoverage = ({
  allowlist,
  records,
  repairs,
}: {
  allowlist: Readonly<Record<string, string>>;
  records: readonly OnlineRepairRehearsalRecord[];
  repairs: readonly OnlineRepair[];
}): void => {
  for (const [name, reason] of Object.entries(allowlist)) {
    if (reason.trim() === "") {
      panic(`Online repair rehearsal allowlist entry ${name} needs a reason`);
    }
  }
  const exercised = new Set(
    records.flatMap(({ name, precondition }) =>
      precondition === "non-empty" ? [name] : [],
    ),
  );
  const missing = repairs
    .map(({ name }) => name)
    .filter((name) => !exercised.has(name) && allowlist[name] === undefined);
  if (missing.length > 0) {
    panic(
      `Online repair rehearsal did not execute against non-empty input: ${missing.join(", ")}`,
    );
  }
};
