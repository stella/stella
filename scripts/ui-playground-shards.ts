import {
  type CiBrowserSuiteLeg,
  parseCiBrowserSuiteLegs,
} from "./ci-browser-suites";

export const UI_PLAYGROUND_SHARD_COUNT = 6;

export type UiPlaygroundMatrixLeg = {
  suite: string;
  specs: readonly string[];
};

class InvalidUiPlaygroundSpecsError extends Error {
  override name = "InvalidUiPlaygroundSpecsError";
}

type PlanUiPlaygroundMatrixOptions = {
  selectedSpecs: readonly string[];
  allSpecs: readonly string[];
  eventName: string;
  desktopRequired: boolean;
  /** Pull request legs that run changed specs of whole-suite legs. */
  suiteLegs?: readonly CiBrowserSuiteLeg[];
};

const playgroundLegs = (
  specs: readonly string[],
  count: number,
): UiPlaygroundMatrixLeg[] => {
  const legs = Array.from({ length: count }, (_, index) => ({
    suite: `playground-${index + 1}`,
    specs: [] as string[],
  }));
  for (const [index, spec] of specs.toSorted().entries()) {
    legs[index % count]?.specs.push(spec);
  }
  return legs;
};

export const planUiPlaygroundMatrix = ({
  selectedSpecs,
  allSpecs,
  eventName,
  desktopRequired,
  suiteLegs = [],
}: PlanUiPlaygroundMatrixOptions): UiPlaygroundMatrixLeg[] => {
  if (eventName !== "pull_request") {
    return [
      { suite: "desktop", specs: [] },
      { suite: "ui", specs: [] },
      ...playgroundLegs(allSpecs, UI_PLAYGROUND_SHARD_COUNT),
    ];
  }

  // The desktop leg runs its whole suite; changed-spec legs carry their
  // specs. An empty selection keeps one leg so the matrix stays valid.
  const fixedLegs = [
    ...(desktopRequired ||
    (selectedSpecs.length === 0 && suiteLegs.length === 0)
      ? [{ suite: "desktop", specs: [] }]
      : []),
    ...suiteLegs.map(({ suite, specs }) => ({ suite, specs })),
  ];
  if (selectedSpecs.length === 0) {
    return fixedLegs;
  }
  const specsPerMergeGroupShard = Math.ceil(
    allSpecs.length / UI_PLAYGROUND_SHARD_COUNT,
  );
  const count =
    selectedSpecs.length === allSpecs.length
      ? UI_PLAYGROUND_SHARD_COUNT
      : Math.min(
          UI_PLAYGROUND_SHARD_COUNT,
          Math.ceil(selectedSpecs.length / specsPerMergeGroupShard),
        );
  return [...fixedLegs, ...playgroundLegs(selectedSpecs, count)];
};

if (import.meta.main) {
  const selectedSpecs: unknown = JSON.parse(
    process.env["UI_PLAYGROUND_SELECTED_SPECS"] ?? "[]",
  );
  const allSpecs: unknown = JSON.parse(
    process.env["UI_PLAYGROUND_ALL_SPECS"] ?? "[]",
  );
  if (
    !Array.isArray(selectedSpecs) ||
    !selectedSpecs.every((spec) => typeof spec === "string") ||
    !Array.isArray(allSpecs) ||
    !allSpecs.every((spec) => typeof spec === "string")
  ) {
    throw new InvalidUiPlaygroundSpecsError(
      "UI playground specs must be JSON arrays of strings",
    );
  }
  console.log(
    JSON.stringify(
      planUiPlaygroundMatrix({
        selectedSpecs,
        allSpecs,
        eventName: process.env["EVENT_NAME"] ?? "",
        desktopRequired: process.env["DESKTOP_REQUIRED"] === "true",
        suiteLegs: parseCiBrowserSuiteLegs(
          process.env["BROWSER_SUITE_LEGS"] ?? "[]",
        ),
      }),
    ),
  );
}
