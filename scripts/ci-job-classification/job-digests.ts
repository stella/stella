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
          // A caller without its own permissions passes on what it inherited
          // from its callers, so a grant reaches every level of nested calls.
          const callerInherited = inheritedGrants.get(callerKey);
          const grant =
            caller.shape.job["permissions"] ??
            caller.shape.job["workflow-permissions"] ??
            (callerInherited?.size
              ? Object.fromEntries(
                  [...callerInherited.entries()].toSorted(([left], [right]) =>
                    compareCodeUnit(left, right),
                  ),
                )
              : "read");
          for (const [calleeJobId, calleeJob] of Object.entries(callee.jobs)) {
            if ("permissions" in calleeJob.shape.job) {
              continue;
            }
            const calleeKey = `${calleeNode.repository}:${calleeNode.path}/${calleeJobId}`;
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
