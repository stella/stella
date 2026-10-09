import * as v from "valibot";

import type { QueryPerfProfileId } from "../profiles";
import aggregateProfile from "./aggregate-profile.json";
import {
  capturedProfileSchema,
  deriveSyntheticProfile,
} from "./captured-profile";

export const loadSyntheticProfile = (profileId: QueryPerfProfileId) =>
  deriveSyntheticProfile({
    profile: v.parse(capturedProfileSchema, aggregateProfile),
    profileId,
  });
