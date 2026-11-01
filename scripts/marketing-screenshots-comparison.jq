# Owner of "the marketing screenshots job failed only in its comparison".
# Marketing screenshots never gate a release, but only a comparison failure
# is advisory: a failure in install, seed, migrate, API boot or the capture
# itself blocks. Included by release-heavy-verdict.jq (main/heavy runs) and
# by ci.yml's ci-result (a release pull request's merge group):
#   include "marketing-screenshots-comparison" {search: "./"};
# or, inline, `jq -L <this directory> 'include "marketing-screenshots-comparison"; ...'`.
#
# The names are the ones the workflows report; release-heavy-verdict.test.ts
# derives them from the workflows and fails when they drift.

# The job's name in a run of ci.yml itself; a caller of ci.yml prefixes its
# own job id ("suites / ...").
def screenshot_check_job: "marketing-screenshots / check";
# The job id in ci.yml's `needs`, hence ci-result's name for it.
def screenshot_required_job: "marketing-screenshots";
# How ci-result's full-depth verdict renders this job's failure.
def screenshot_required_violation: "\(screenshot_required_job) (planned, failure)";
def screenshot_capture_step: "Capture marketing screenshots";
# marketing-screenshots.yml runs this step only when the comparison started
# and did not finish.
def screenshot_comparison_marker_step: "Screenshot comparison failed";

# True for a job object (with its steps) that failed only in the capture
# step, after the comparison started: every other step passed and the marker
# step succeeded. Anything malformed or missing is false.
def screenshot_comparison_only_failure:
  def passed: . as $c | ["success", "skipped", "neutral"] | index($c) != null;
  type == "object"
  and .conclusion == "failure"
  and (.steps | type) == "array"
  and ([.steps[] | if type == "object" then . else {name: null, conclusion: "invalid"} end
      | select((.conclusion // "") | passed | not) | .name] == [screenshot_capture_step])
  and ([.steps[] | select(type == "object" and .name == screenshot_comparison_marker_step and .conclusion == "success")] | length) == 1;
