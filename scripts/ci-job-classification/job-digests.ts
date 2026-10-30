import { compareCodeUnit } from "../../packages/collation/src/collation";
import { sha256 } from "./classification-values";
import { isPrivilegedJobClosure } from "./review";
import { AdmissionError } from "./yaml";
import type { ParsedDocument } from "./yaml";

type MetadataNode = {
  type: "metadata";
  id: string;
  repository: string;
  path: string;
  edges: Record<string, string>;
};
type DigestNode = MetadataNode | { type: "supplier"; id: string };

type DerivePrivilegesOptions = {
  nodes: ReadonlyMap<string, DigestNode>;
  parsedDocuments: ReadonlyMap<string, ParsedDocument>;
  decisions: Readonly<
    Record<string, { kind: "ordinary" | "support" | "priority" } | undefined>
  >;
};

export const reachableJobDocuments = ({
  initialTargets,
  nodes,
  parsedDocuments,
}: Omit<DerivePrivilegesOptions, "decisions"> & {
  initialTargets: string[];
}) => {
  const documents: ParsedDocument[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    const node = nodes.get(id);
    const parsed = parsedDocuments.get(id);
    if (!node || node.type !== "metadata" || !parsed) {
      return;
    }
    documents.push(parsed);
    for (const target of Object.values(node.edges)) {
      visit(target);
    }
  };
  for (const target of initialTargets) {
    visit(target);
  }
  return documents;
};

/**
 * The token grant a reusable-workflow call passes to its callee: the caller's
 * own permissions, else its workflow's, else what the caller itself inherited,
 * so a grant reaches every level of nested calls.
 */
const outgoingGrant = (
  callerShape: Readonly<Record<string, unknown>>,
  callerInherited: ReadonlyMap<string, unknown> | undefined,
): unknown =>
  callerShape["permissions"] ??
  callerShape["workflow-permissions"] ??
  (callerInherited?.size
    ? Object.fromEntries(
        [...callerInherited.entries()].toSorted(([left], [right]) =>
          compareCodeUnit(left, right),
        ),
      )
    : "read");

export const deriveJobPrivileges = ({
  nodes,
  parsedDocuments,
  decisions,
}: DerivePrivilegesOptions) => {
  const jobPrivileges = new Map<string, boolean>();
  const inheritedGrants = new Map<string, Map<string, unknown>>();
  for (const node of nodes.values()) {
    if (node.type !== "metadata") {
      continue;
    }
    const parsed = parsedDocuments.get(node.id);
    if (!parsed) {
      throw new AdmissionError({ message: "parsed metadata missing" });
    }
    for (const [jobId, job] of Object.entries(parsed.jobs)) {
      const key = `${node.repository}:${node.path}/${jobId}`;
      const targets = Object.keys(job.dependencies).flatMap((reference) => {
        const target = node.edges[reference];
        return target ? [target] : [];
      });
      jobPrivileges.set(
        key,
        isPrivilegedJobClosure({
          kind: decisions[key]?.kind,
          privileged: job.privileged,
          shape: job.shape,
          reachableDocuments: reachableJobDocuments({
            initialTargets: targets,
            nodes,
            parsedDocuments,
          }),
        }),
      );
    }
  }

  // Jobs that run in the context of a privileged event, directly or through
  // any chain of reusable-workflow calls.
  const privilegedEventJobs = new Set<string>();
  let privilegeChanged = true;
  while (privilegeChanged) {
    privilegeChanged = false;
    for (const node of nodes.values()) {
      if (node.type !== "metadata") {
        continue;
      }
      const parsed = parsedDocuments.get(node.id);
      if (!parsed) {
        throw new AdmissionError({ message: "parsed metadata missing" });
      }
      for (const [jobId, caller] of Object.entries(parsed.jobs)) {
        const callerKey = `${node.repository}:${node.path}/${jobId}`;
        if (!jobPrivileges.get(callerKey)) {
          continue;
        }
        for (const [reference, kind] of Object.entries(caller.dependencies)) {
          if (kind !== "reusable-workflow") {
            continue;
          }
          const target = node.edges[reference];
          const callee = target ? parsedDocuments.get(target) : undefined;
          const calleeNode = target ? nodes.get(target) : undefined;
          if (!callee || !calleeNode || calleeNode.type !== "metadata") {
            continue;
          }
          const grant = outgoingGrant(
            caller.shape.job,
            inheritedGrants.get(callerKey),
          );
          // A callee's own permissions can only narrow a token grant; under a
          // privileged event the callee runs in that context regardless.
          const privilegedEvent =
            caller.shape.job["workflow-privileged-event"] === true ||
            privilegedEventJobs.has(callerKey);
          for (const [calleeJobId, calleeJob] of Object.entries(callee.jobs)) {
            if ("permissions" in calleeJob.shape.job && !privilegedEvent) {
              continue;
            }
            const calleeKey = `${calleeNode.repository}:${calleeNode.path}/${calleeJobId}`;
            if (privilegedEvent && !privilegedEventJobs.has(calleeKey)) {
              privilegedEventJobs.add(calleeKey);
              privilegeChanged = true;
            }
            const grants = inheritedGrants.get(calleeKey) ?? new Map();
            // Reusable workflows cannot call themselves, so grants settle.
            if (
              JSON.stringify(grants.get(callerKey)) !== JSON.stringify(grant)
            ) {
              grants.set(callerKey, grant);
              privilegeChanged = true;
            }
            inheritedGrants.set(calleeKey, grants);
            if (!jobPrivileges.get(calleeKey)) {
              jobPrivileges.set(calleeKey, true);
              privilegeChanged = true;
            }
          }
        }
      }
    }
  }
  return { jobPrivileges, inheritedGrants };
};

type JobDependencyDigestsOptions = {
  definition: ParsedDocument["jobs"][string];
  edges: Readonly<Record<string, string>>;
  isMetadata: (target: string) => boolean;
  documentDigest: (target: string) => string;
};

/**
 * The digests of the metadata documents a job depends on. A reusable-workflow
 * caller is classified by its call surface, so its callees contribute none.
 */
export const jobDependencyDigests = ({
  definition,
  edges,
  isMetadata,
  documentDigest,
}: JobDependencyDigestsOptions): Record<string, string> => {
  if (Object.values(definition.dependencies).includes("reusable-workflow")) {
    return {};
  }
  return Object.fromEntries(
    Object.keys(definition.dependencies)
      .toSorted(compareCodeUnit)
      .flatMap((reference) => {
        const target = edges[reference];
        return target && isMetadata(target)
          ? [[reference, documentDigest(target)]]
          : [];
      }),
  );
};

type ExpectedJobDigestOptions = {
  definition: ParsedDocument["jobs"][string];
  privileged: boolean;
  inheritedGrants?: ReadonlyMap<string, unknown> | undefined;
  dependencyDigests: Record<string, string>;
};

export const expectedJobDigest = ({
  definition,
  privileged,
  inheritedGrants,
  dependencyDigests,
}: ExpectedJobDigestOptions) => {
  let digest = privileged ? definition.privilegedDigest : definition.digest;
  if (privileged && inheritedGrants?.size) {
    digest = sha256(
      JSON.stringify({
        digest,
        inheritedPermissions: Object.fromEntries(
          [...inheritedGrants.entries()].toSorted(([left], [right]) =>
            compareCodeUnit(left, right),
          ),
        ),
      }),
    );
  }
  return Object.keys(dependencyDigests).length
    ? sha256(JSON.stringify({ digest, dependencies: dependencyDigests }))
    : digest;
};
