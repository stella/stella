import type { api } from "@/lib/api";

// All Workflow (internal: "flow") shapes are inferred from the Eden API
// surface so the editor's working state and save payload stay in lockstep
// with the backend `flowDefinitionBodySchema` / `flow-types.ts`. Never
// hand-redefine the step or trigger shape here.

type FlowDetailResponse = Awaited<
  ReturnType<ReturnType<typeof api.flows>["get"]>
>;

type FlowDetailData = Exclude<
  NonNullable<Extract<FlowDetailResponse, { data: unknown }>["data"]>,
  Response
>;

export type FlowDefinitionDetail = FlowDetailData;
export type FlowStep = FlowDefinitionDetail["steps"][number];
export type FlowTrigger = FlowDefinitionDetail["trigger"];

type FlowListResponse = Awaited<ReturnType<typeof api.flows.get>>;

type FlowListData = Exclude<
  NonNullable<Extract<FlowListResponse, { data: unknown }>["data"]>,
  Response
>;

export type FlowListItem = FlowListData["items"][number];

// The save payload mirrors the create/update body contract.
export type FlowDefinitionBody = Parameters<typeof api.flows.post>[0];
