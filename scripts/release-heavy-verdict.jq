# Owner of "main/heavy is green for release purposes" when the run itself
# failed. Called as `jq -n --argjson jobs <latest-attempt job list> -f this`
# by check-release-main-health.sh and, through release-heavy-verdict.ts, by
# prepare-maintenance-release.ts.
#
# Marketing screenshots never gate a release: their failure starts a fix and
# the release proceeds. A red heavy run is therefore green here only when
# every job that did not pass is either an advisory job, or an aggregate that
# fails by construction once an advisory job has failed. Any other
# unsuccessful job (including cancelled, queued, unnamed) blocks.
#
# The names below are the nested job names GitHub reports for main-heavy.yml
# (caller job id / called job id); release-heavy-verdict.test.ts derives them
# from the workflows and fails when they drift.
def advisory_jobs: ["suites / marketing-screenshots / check"];
# The ci-result rollup and main-heavy's status job exit non-zero whenever any
# job failed, so they carry no information beyond the other failures.
def aggregate_jobs: ["suites / ci-result", "status"];

def isin($list): . as $name | ($list | index($name)) != null;
def passing: . as $c | ["success", "skipped", "neutral"] | index($c) != null;
def describe: "\(.name // "(a job GitHub returned without a name)") (\(.conclusion // .status // "unknown"))";

if ($jobs | type) != "array" then
  { advisory: [], blocking: ["(job list unreadable)"], advisoryOnly: false }
else
  ($jobs | map(if type == "object" then . else {conclusion: "invalid"} end)) as $entries
  | ($entries | map(select((.conclusion // "") | passing | not))) as $unpassed
  | ($unpassed | map(select(.conclusion == "failure" and (.name | isin(advisory_jobs))))) as $advisory
  | ($unpassed | map(select(.conclusion == "failure" and (.name | isin(aggregate_jobs))))) as $aggregate
  | ($unpassed - $advisory - (if ($advisory | length) > 0 then $aggregate else [] end)) as $blocking
  | {
      advisoryJobs: advisory_jobs,
      aggregateJobs: aggregate_jobs,
      advisory: ($advisory | map(.name)),
      blocking: ($blocking | map(describe)),
      advisoryOnly: (($advisory | length) > 0 and ($blocking | length) == 0)
    }
end
