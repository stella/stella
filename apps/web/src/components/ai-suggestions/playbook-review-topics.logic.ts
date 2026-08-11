type PlaybookTopicSeed = {
  type: "playbook";
  topicId: string;
  positionId: string;
  title: string;
  context: string;
  included: boolean;
};

type PlaybookFindingTopicSource = {
  positionId: string;
  issue: string;
};

/**
 * Pure-playbook reviews have no topic-confirmation step. Derive their result
 * topics from the findings the review engine actually produced so the UI
 * cannot drift from the backend's executable-position policy.
 */
export const topicsFromPlaybookFindings = (
  findings: readonly PlaybookFindingTopicSource[],
  seededTopics: readonly PlaybookTopicSeed[],
): PlaybookTopicSeed[] => {
  const seedByPositionId = new Map(
    seededTopics.map((topic) => [topic.positionId, topic]),
  );
  return findings.map((finding) => {
    const seed = seedByPositionId.get(finding.positionId);
    return {
      type: "playbook",
      topicId: finding.positionId,
      positionId: finding.positionId,
      title: finding.issue,
      context: seed?.context ?? "",
      included: true,
    };
  });
};
