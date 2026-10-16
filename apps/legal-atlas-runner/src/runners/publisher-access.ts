import { panic } from "better-result";

import type { AdapterKey } from "@/api/handlers/case-law/consts";
import type { publisherAccessAdmission } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";

const PUBLISHER_ACCESS_WAIT_SLICE_MS = 60_000;

type AcquirePublisherCycleSlotOptions = {
  adapterKey: AdapterKey;
  admission: typeof publisherAccessAdmission;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  isDraining: () => boolean;
  acquire: () => Promise<void>;
  release: () => void;
};

type PublisherCycleSlotResult =
  | { type: "acquired" }
  | { type: "drained" }
  | Extract<
      ReturnType<typeof publisherAccessAdmission>,
      { type: "unavailable" }
    >;

/** Wait without holding a cycle slot, then recheck after queueing for one. */
export const acquirePublisherCycleSlot = async ({
  adapterKey,
  admission,
  now,
  sleep,
  isDraining,
  acquire,
  release,
}: AcquirePublisherCycleSlotOptions): Promise<PublisherCycleSlotResult> => {
  while (!isDraining()) {
    const currentTime = now();
    const access = admission(adapterKey, currentTime);
    switch (access.type) {
      case "unavailable":
        return access;
      case "closed":
        await sleep(
          Math.min(
            PUBLISHER_ACCESS_WAIT_SLICE_MS,
            access.opensAt - currentTime,
          ),
        );
        continue;
      case "open":
        break;
      default:
        access satisfies never;
        return panic("Unhandled publisher access admission");
    }

    await acquire();
    if (isDraining()) {
      release();
      return { type: "drained" };
    }
    const acquiredAccess = admission(adapterKey, now());
    if (acquiredAccess.type === "open") {
      return { type: "acquired" };
    }
    release();
    if (acquiredAccess.type === "unavailable") {
      return acquiredAccess;
    }
  }
  return { type: "drained" };
};
