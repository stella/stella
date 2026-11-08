import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  notValidChecksOf,
  schemaCheckCondition,
} from "@/api/tests/helpers/migration-checks";

import { oauthRefreshToken } from "./auth-schema";

const ROTATION_CHECKS = [
  "oauth_refresh_token_rotation_revokes_check",
  "oauth_refresh_token_replay_window_check",
  "oauth_refresh_token_replay_response_check",
];

test("every refresh-token rotation check in the schema is the one its migration adds", () => {
  const added = notValidChecksOf("20261106130000_oauth_refresh_rotation_shape");
  expect([...added.keys()].toSorted()).toEqual(ROTATION_CHECKS.toSorted());
  for (const name of ROTATION_CHECKS) {
    expect(added.get(name)).toEqual({
      tableName: getTableConfig(oauthRefreshToken).name,
      condition: schemaCheckCondition(oauthRefreshToken, name),
    });
  }
});
