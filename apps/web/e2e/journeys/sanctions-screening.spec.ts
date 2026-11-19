import { type APIRequestContext, expect, test } from "@playwright/test";
import { panic } from "better-result";
import { createReadStream } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { JOURNEY_PREREQUISITE } from "@stll/api-contract/journey-prerequisites";
import { parseEuList } from "@stll/sanctions";

import { E2E_API_ORIGIN } from "../helpers/api";
import {
  establishDeployedJourneyPrerequisites,
  JOURNEY_PREREQUISITE_TIMEOUT_MS,
} from "../helpers/journey-prerequisites";
import { JOURNEY_TAG } from "../playwright.journeys.config";

const EU_FIXTURE = path.resolve(
  import.meta.dirname,
  "../../../../packages/sanctions/src/fixtures/eu.xml",
);
const SCREENING_STATUS = {
  busy: "busy",
  warming: "warming",
  screened: "screened",
} as const;
const LIST_REASON_WARMING = "warming";
const SCREENING_TIMEOUT_MS = 120_000;
const SCREENING_POLL_MS = 5000;
/** Reading the fixture and the requests around the two waits. */
const JOURNEY_MARGIN_MS = 60_000;

const screeningSchema = v.object({
  lists: v.array(
    v.object({
      source: v.string(),
      status: v.string(),
      reason: v.nullable(v.string()),
      possibleMatches: v.array(v.object({ sourceEntryId: v.string() })),
    }),
  ),
});

const readFixtureOrganisation = async () => {
  const parsed = await parseEuList(createReadStream(EU_FIXTURE));
  const entry = parsed
    .unwrap()
    .entries.find(({ entityType }) => entityType === "organisation");
  const name = entry?.names.at(0)?.name;
  if (entry === undefined || name === undefined) {
    return panic("The EU sanctions fixture lists no named organisation");
  }
  return { name, source: entry.source };
};

type ScreenOptions = {
  name: string;
  request: APIRequestContext;
  source: string;
};

const screen = async ({ name, request, source }: ScreenOptions) => {
  const response = await request.post(`${E2E_API_ORIGIN}/v1/sanctions/search`, {
    data: { subject: { type: "organization", name } },
    failOnStatusCode: false,
  });
  if (response.status() === 503) {
    return { status: SCREENING_STATUS.busy };
  }
  expect(response.ok(), await response.text()).toBe(true);
  const { lists } = v.parse(screeningSchema, await response.json());
  if (lists.some(({ reason }) => reason === LIST_REASON_WARMING)) {
    return { status: SCREENING_STATUS.warming };
  }
  const list = lists.find((outcome) => outcome.source === source);
  return {
    status: SCREENING_STATUS.screened,
    listStatus: list?.status,
    listReason: list?.reason,
  };
};

test(
  "the deployed EU sanctions list is available for screening",
  { tag: JOURNEY_TAG.deployed },
  async ({ request }) => {
    // timeout: the refresh job brought forward runs first, then the screening poll.
    test.setTimeout(
      JOURNEY_PREREQUISITE_TIMEOUT_MS +
        SCREENING_TIMEOUT_MS +
        JOURNEY_MARGIN_MS,
    );
    // A list older than its freshness window is stale until the refresh job
    // runs; staging may have been off for longer than that window.
    await establishDeployedJourneyPrerequisites(
      JOURNEY_PREREQUISITE.sanctionsScreening,
    );
    // The deployed edition may differ from the checked-in name fixture.
    // Controlled edition fixtures cover matching in the API database suite.
    const { name, source } = await readFixtureOrganisation();

    await expect
      .poll(async () => await screen({ name, request, source }), {
        intervals: [SCREENING_POLL_MS],
        timeout: SCREENING_TIMEOUT_MS,
      })
      .toEqual({
        status: SCREENING_STATUS.screened,
        listStatus: expect.stringMatching(/^(?:clear|possible-match)$/u),
        listReason: null,
      });
  },
);
