import { panic } from "better-result";
import { requireOptionalNativeModule } from "expo";

export type NativeDraft = {
  readonly id: string;
  readonly matterId: string | null;
  readonly status: "recording" | "paused" | "finished";
  readonly elapsedMs: number;
  readonly markers: readonly number[];
  readonly levels: readonly { readonly timeMs: number; readonly db: number }[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastMeterAt: number | null;
  readonly recordingSince: number | null;
  readonly cleaningProgress: number | null;
};

export type DictationAudio = {
  readonly uri: string;
  readonly size: number;
  readonly sha256Hex: string;
};

export type DraftScope = {
  readonly serverOrigin: string;
  readonly userId: string;
};

type DictationRecorderModule = {
  readonly suspend: (scope: DraftScope) => Promise<void>;
  readonly listDrafts: (scope: DraftScope) => Promise<NativeDraft[]>;
  readonly start: (
    scope: DraftScope,
    matterId: string | null,
  ) => Promise<NativeDraft>;
  readonly pause: (scope: DraftScope, id: string) => Promise<NativeDraft>;
  readonly resume: (scope: DraftScope, id: string) => Promise<NativeDraft>;
  readonly finish: (scope: DraftScope, id: string) => Promise<NativeDraft>;
  readonly addMarker: (scope: DraftScope, id: string) => Promise<NativeDraft>;
  readonly deleteDraft: (scope: DraftScope, id: string) => Promise<void>;
  readonly status: (scope: DraftScope, id: string) => Promise<NativeDraft>;
  readonly exportAudio: (
    scope: DraftScope,
    id: string,
    cleaned: boolean,
  ) => Promise<DictationAudio>;
  readonly shareAudio: (scope: DraftScope, uri: string) => Promise<boolean>;
};

const recorder =
  requireOptionalNativeModule<DictationRecorderModule>("DictationRecorder");

export const canRecordDictation = (): boolean => recorder !== null;

const requireRecorder = (): DictationRecorderModule =>
  recorder ?? panic("Dictation operations require canRecordDictation().");

export const createDictationRecorder = (scope: DraftScope) => ({
  suspend: async (): Promise<void> => {
    if (recorder !== null) {
      await recorder.suspend(scope);
    }
  },
  listDrafts: async (): Promise<NativeDraft[]> =>
    recorder === null ? [] : await recorder.listDrafts(scope),
  start: async (matterId: string | null): Promise<NativeDraft> =>
    await requireRecorder().start(scope, matterId),
  pause: async (id: string): Promise<NativeDraft> =>
    await requireRecorder().pause(scope, id),
  resume: async (id: string): Promise<NativeDraft> =>
    await requireRecorder().resume(scope, id),
  finish: async (id: string): Promise<NativeDraft> =>
    await requireRecorder().finish(scope, id),
  addMarker: async (id: string): Promise<NativeDraft> =>
    await requireRecorder().addMarker(scope, id),
  deleteDraft: async (id: string): Promise<void> =>
    await requireRecorder().deleteDraft(scope, id),
  status: async (id: string): Promise<NativeDraft> =>
    await requireRecorder().status(scope, id),
  exportAudio: async (id: string, cleaned: boolean): Promise<DictationAudio> =>
    await requireRecorder().exportAudio(scope, id, cleaned),
  shareAudio: async (uri: string): Promise<boolean> =>
    await requireRecorder().shareAudio(scope, uri),
});

export type DictationRecorder = ReturnType<typeof createDictationRecorder>;
