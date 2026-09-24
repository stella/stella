import { and, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import { auditLogs } from "@/api/db/schema";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

import {
  FEED_ACTIVITY_RESOURCE_TYPES,
  VISIBLE_ACTIVITY_ACTIONS,
} from "./read-overview-activity.logic";

const LEGACY_VISIBLE_RESOURCE_TYPES = [
  AUDIT_RESOURCE_TYPE.ENTITY,
  AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
  AUDIT_RESOURCE_TYPE.FIELD,
  AUDIT_RESOURCE_TYPE.USER_FILE,
  AUDIT_RESOURCE_TYPE.WORKSPACE,
  AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER,
  AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT,
  AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK,
  AUDIT_RESOURCE_TYPE.FLOW_RUN,
] as const;

export const visibleActivityCondition = () =>
  and(
    inArray(auditLogs.action, VISIBLE_ACTIVITY_ACTIONS),
    // Every feed row must resolve to a named target, so the query admits only
    // the resource types the projection names. A resource excluded there can
    // never arrive here to be labelled generically.
    inArray(auditLogs.resourceType, FEED_ACTIVITY_RESOURCE_TYPES),
    // "other" is housekeeping — session expiry, retention sweeps — and stays
    // out of the matter's story no matter who performed it. The performer
    // test only rescues rows written before activityCategory existed.
    or(
      and(
        isNotNull(auditLogs.activityCategory),
        ne(auditLogs.activityCategory, "other"),
      ),
      and(
        isNull(auditLogs.activityCategory),
        or(
          ne(auditLogs.performerType, "user"),
          inArray(auditLogs.resourceType, LEGACY_VISIBLE_RESOURCE_TYPES),
        ),
      ),
    ),
  ) ?? sql`false`;
