// Compatibility shim — the inspector promotion landed under
// `@/components/inspector/*`. Callers should switch to the new
// path; this file forwards explicit symbols only and disappears
// in the follow-up cleanup PR.
export {
  buildSkillResourceTabId,
  getInspectorTabsBroadcastChannelName,
  initializeInspectorTabBroadcast,
  isGenericInspectorTab,
  useInspectorStore,
} from "@/components/inspector/inspector-store";
export type {
  ChatTab,
  ExternalTab,
  ExternalTabId,
  FileTab,
  GenericTab,
  InspectorTab,
  MatterTab,
  MatterTabId,
  SkillResourceTab,
  SkillResourceTabId,
  TaskTab,
} from "@/components/inspector/inspector-store";
