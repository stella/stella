import { Result } from "better-result";

import {
  CHAT_SOURCE_CITATION_REF_PREFIX,
  CHAT_UNRESOLVED_REF_HREF,
  type ChatRefRegistry,
} from "@/api/lib/chat/ref-registry";
import {
  CHAT_REF_TOKEN_PREFIX,
  CHAT_SOURCE_REF_PREFIX,
  type ChatRefTokenKind,
} from "@/api/lib/chat/ref-token";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";

// `chat.persisted.refs-stable`. A chat ref (`ent_1`, `mat_2`, `src_3`, …) is
// minted by the registry of one request, but a stored message can show it to
// the model verbatim (a code-mode result, prose), and every later request of
// the thread builds its own registry. What a ref names in a request is what
// that request's registry resolves it to: the target a tool call reads and an
// answer link points at. The ledger records each request's registry, learns
// the target of every ref the stored thread holds from the request that first
// stored it, and checks that every later request resolves it to that target.

type RefProbe = {
  prefix: string;
  /** What `ref` names in the request `registry` serves, or null. */
  target: (registry: ChatRefRegistry, ref: string) => string | null;
};

const firstOf = <T>(
  resolved: Result<T[], unknown>,
  describe: (target: T) => string,
): string | null => {
  if (Result.isError(resolved)) {
    return null;
  }
  const target = resolved.value.at(0);
  return target === undefined ? null : describe(target);
};

const REF_PROBES = {
  contact: {
    prefix: CHAT_REF_TOKEN_PREFIX.contact,
    target: (registry, ref) =>
      firstOf(registry.resolveContactRefs([ref]), (id) => `contact ${id}`),
  },
  entity: {
    prefix: CHAT_REF_TOKEN_PREFIX.entity,
    target: (registry, ref) =>
      firstOf(
        registry.resolveEntityRefTargets([ref]),
        ({ entityId, workspaceId }) => `entity ${workspaceId}/${entityId}`,
      ),
  },
  matter: {
    prefix: CHAT_REF_TOKEN_PREFIX.matter,
    target: (registry, ref) =>
      firstOf(registry.resolveMatterRefs([ref]), (id) => `matter ${id}`),
  },
  property: {
    prefix: CHAT_REF_TOKEN_PREFIX.property,
    target: (registry, ref) =>
      firstOf(registry.resolvePropertyRefs([ref]), (id) => `property ${id}`),
  },
  source: {
    prefix: CHAT_SOURCE_REF_PREFIX,
    target: (registry, ref) => {
      // An answer link to the ref, as the model writes one.
      const href = registry.resolveAssistantTextRefs(
        `${CHAT_SOURCE_CITATION_REF_PREFIX}${ref}`,
      );
      return href === CHAT_UNRESOLVED_REF_HREF ? null : `source ${href}`;
    },
  },
} as const satisfies Record<ChatRefTokenKind | "source", RefProbe>;

const PROBES: readonly RefProbe[] = Object.values(REF_PROBES);

/** Every whole ref token, wherever it sits in serialized parts. */
const REF_TOKEN_PATTERN = new RegExp(
  `\\b(?:${PROBES.map(({ prefix }) => prefix).join("|")})_[1-9][0-9]*\\b`,
  "gu",
);

const targetOf = (registry: ChatRefRegistry, ref: string): string | null =>
  PROBES.find(({ prefix }) => ref.startsWith(`${prefix}_`))?.target(
    registry,
    ref,
  ) ?? null;

/** A stored message: only what it shows the model is read. */
type StoredMessage = { parts: unknown };

/** The ref tokens the stored thread holds, in any part. */
const storedRefTokens = (messages: readonly StoredMessage[]): Set<string> =>
  new Set(
    messages.flatMap(({ parts }) =>
      [...JSON.stringify(parts).matchAll(REF_TOKEN_PATTERN)].map(
        ([token]) => token,
      ),
    ),
  );

type ThreadLedger = {
  /** Every violation found on the thread so far. */
  findings: OracleViolation[];
  /** Registries not yet checked, in the order their requests built them. */
  pending: ChatRefRegistry[];
  /** Each stored ref and the target it named when first stored. */
  shown: Map<string, string>;
};

export const createRefStabilityLedger = () => {
  const threads = new Map<string, ThreadLedger>();
  const ledgerOf = (threadId: string): ThreadLedger => {
    const known = threads.get(threadId);
    if (known !== undefined) {
      return known;
    }
    const created: ThreadLedger = {
      findings: [],
      pending: [],
      shown: new Map(),
    };
    threads.set(threadId, created);
    return created;
  };

  return {
    /** Records the registry a request of `threadId` built; returns it. */
    track: (threadId: string, registry: ChatRefRegistry): ChatRefRegistry => {
      ledgerOf(threadId).pending.push(registry);
      return registry;
    },
    /**
     * Once a request of `threadId` has settled: every ref stored before it
     * must name its first target in each registry built since the last
     * check, and refs first stored now are learned from the newest one. A
     * token that registry does not resolve (text a user typed) is not a
     * minted ref and is not tracked. Every tracked ref must also be in the
     * thread's stored ref state (`threadRefs`), which later requests restore.
     * Returns the new violations.
     */
    check: ({
      stored,
      threadId,
      threadRefs,
    }: {
      stored: readonly StoredMessage[];
      threadId: string;
      threadRefs: ReadonlySet<string>;
    }): OracleViolation[] => {
      const ledger = ledgerOf(threadId);
      const registries = ledger.pending.splice(0);
      const moved = registries.flatMap((registry) =>
        [...ledger.shown].flatMap(([ref, shown]) => {
          const later = targetOf(registry, ref);
          return later === shown ? [] : [{ later, ref, shown }];
        }),
      );
      const newest = registries.at(-1);
      for (const ref of newest === undefined ? [] : storedRefTokens(stored)) {
        const target =
          newest === undefined || ledger.shown.has(ref)
            ? null
            : targetOf(newest, ref);
        if (target !== null) {
          ledger.shown.set(ref, target);
        }
      }
      const findings = violationsOf(CHAT_ORACLE.persistedRefsStable, [
        ...moved,
        ...[...ledger.shown.keys()]
          .filter((ref) => !threadRefs.has(ref))
          .map((ref) => ({ missingFromThreadState: ref })),
      ]);
      ledger.findings.push(...findings);
      return findings;
    },
    /** Every violation found on `threadId` so far. */
    findingsOf: (threadId: string): readonly OracleViolation[] =>
      ledgerOf(threadId).findings,
  };
};
