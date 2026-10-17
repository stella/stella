import { expect, test, type APIRequestContext } from "@playwright/test";
import { panic } from "better-result";
import { createReadStream } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { parseEuList } from "@stll/sanctions";

import { E2E_API_ORIGIN } from "../helpers/api";
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
const LIST_STATUS_POSSIBLE_MATCH = "possible-match";
const SCREENING_TIMEOUT_MS = 120_000;
const SCREENING_POLL_MS = 5000;

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
  return { name, source: entry.source, sourceEntryId: entry.sourceId };
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
    matchedEntryIds: list?.possibleMatches.map(
      ({ sourceEntryId }) => sourceEntryId,
    ),
  };
};

test(
  "screening a listed organisation returns its sanctions entry",
  { tag: JOURNEY_TAG.deployed },
  async ({ request }) => {
    const { name, source, sourceEntryId } = await readFixtureOrganisation();

    await expect
      .poll(async () => await screen({ name, request, source }), {
        intervals: [SCREENING_POLL_MS],
        timeout: SCREENING_TIMEOUT_MS,
      })
      .toEqual({
        status: SCREENING_STATUS.screened,
        listStatus: LIST_STATUS_POSSIBLE_MATCH,
        listReason: null,
        matchedEntryIds: expect.arrayContaining([sourceEntryId]),
      });
  },
);
