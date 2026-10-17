import type { SampleCaseLoad } from "@/features/avt/types";

type LoadSampleCaseAndOpenOptions = {
  load: () => Promise<SampleCaseLoad>;
  openList: (listId: SampleCaseLoad["listId"]) => Promise<unknown>;
};

/** The server commits the whole sample before the view opens its list. */
export const loadSampleCaseAndOpen = async ({
  load,
  openList,
}: LoadSampleCaseAndOpenOptions) => {
  const sample = await load();
  await openList(sample.listId);
  return sample;
};
