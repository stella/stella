# Owner of "main/heavy is green for release purposes" when the run itself
# failed. Called as
#   jq -n --argjson jobs <latest-attempt jobs, with steps> --argjson total <API total_count> \
#         --argjson record <ci-required-summary record or null> --argjson run_id <n> --arg head <sha> -f this
# by check-release-main-health.sh and, through release-heavy-verdict.ts, by
# prepare-maintenance-release.ts.
#
# Marketing screenshots never gate a release: their failure starts a fix and
# the release proceeds. A red heavy run is therefore green here only when
#   1. the ci-result required-jobs record (the `ci-required-summary` artifact
#      of the run) shows every required job but marketing-screenshots as
#      success, marketing-screenshots as failure, and no other unmet check
#      (folded sub-suites, jobs missing from JOB_SCOPES): ci-result fails for
#      reasons that are not a failed job, so the job list alone cannot excuse
#      it;
#   2. the screenshots job failed only in the comparison step, after every
#      earlier step succeeded (marketing-screenshots.yml records that with a
#      marker step); a failure in install, seed, migrate or API boot blocks;
#   3. every other unsuccessful job is an aggregate that fails by
#      construction, and the job list is complete.
# Anything unreadable, missing or unclassified blocks.
#
# The names below are the ones the workflows report;
# release-heavy-verdict.test.ts derives them from the workflows and fails
# when they drift.
def advisory_job: "suites / marketing-screenshots / check";
# The job id in ci.yml's `needs`, hence the `job` of the record's entry.
def advisory_required_job: "marketing-screenshots";
def advisory_violation: "marketing-screenshots (planned, failure)";
def advisory_step: "Capture marketing screenshots";
def comparison_marker_step: "Screenshot comparison failed";
# The ci-result rollup and main-heavy's status job exit non-zero whenever any
# job failed; the record decides whether anything but screenshots did.
def aggregate_jobs: ["suites / ci-result", "status"];

def isin($list): . as $name | ($list | index($name)) != null;
def passing: . as $c | ["success", "skipped", "neutral"] | index($c) != null;
def describe: "\(.name // "(a job GitHub returned without a name)") (\(.conclusion // .status // "unknown"))";
def unpassed: select((.conclusion // "") | passing | not);
def comparison_only_failure:
  (.steps | type) == "array"
  and ([.steps[] | if type == "object" then . else {name: null, conclusion: "invalid"} end | unpassed | .name] == [advisory_step])
  and ([.steps[] | select(type == "object" and .name == comparison_marker_step and .conclusion == "success")] | length) == 1;

def record_blocking:
  if ($record | type) != "object" then ["required-jobs record unreadable"]
  else
    $record
    | (if (.required | type) == "array" then .required else [] end) as $required
    | [
        (if .version != 1 then "required-jobs record has an unknown version" else empty end),
        (if .run_id != $run_id or .head_sha != $head then "required-jobs record belongs to another run or commit" else empty end),
        (if .basis != "evaluated" or .verdict != "failure" or .depth != "heavy" then "required-jobs record is not an evaluated heavy failure" else empty end),
        (if ($required | length) == 0 then "required-jobs record lists no required job" else empty end),
        (if .violations_evaluated != true then "required-jobs record did not evaluate the unmet checks" else empty end),
        (if (.violations // advisory_violation) != advisory_violation then "unmet checks: \(.violations)" else empty end),
        (if ([$required[] | select(type == "object" and .job == advisory_required_job and .conclusion == "failure")] | length) != 1 then "required-jobs record has no failed \(advisory_required_job)" else empty end),
        ($required[] | if type != "object" then "a malformed required-jobs entry"
          elif .job != advisory_required_job and .conclusion != "success" then "\(.job) (\(.conclusion))"
          else empty end)
      ]
  end;

def job_verdict:
  ($jobs | map(if type == "object" then . else {conclusion: "invalid"} end)) as $entries
  | ($entries | map(unpassed)) as $failed
  | ($failed | map(select(.conclusion == "failure" and .name == advisory_job and comparison_only_failure))) as $advisory
  | ($failed | map(select(.conclusion == "failure" and (.name | isin(aggregate_jobs))))) as $aggregate
  | ($failed - $advisory - (if ($advisory | length) > 0 then $aggregate else [] end) | map(describe)) as $blocking
  | {
      advisory: ($advisory | map(.name)),
      blocking: (
        $blocking
        + (if ($total | type) == "number" and ($jobs | length) == $total then [] else ["job list incomplete: read \($jobs | length) of \($total)"] end)
        + record_blocking
      )
    };

if ($jobs | type) != "array" then
  { advisory: [], blocking: ["(job list unreadable)"], advisoryOnly: false }
else
  job_verdict
  | . + {
      advisoryJobs: [advisory_job],
      aggregateJobs: aggregate_jobs,
      advisoryRequiredJob: advisory_required_job,
      advisoryStep: advisory_step,
      comparisonMarkerStep: comparison_marker_step,
      advisoryOnly: ((.advisory | length) > 0 and (.blocking | length) == 0)
    }
end
