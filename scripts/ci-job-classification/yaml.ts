import { Result, TaggedError } from "better-result";
import * as v from "valibot";

export class AdmissionError extends TaggedError("AdmissionError")<{
  message: string;
}> {}

const STEP = v.strictObject({
  uses: v.nullable(v.string()),
  run: v.nullable(v.string()),
});
const JOB = v.strictObject({
  digest: v.string(),
  reusableWorkflow: v.nullable(v.string()),
  steps: v.array(STEP),
});
const DOCUMENT = v.strictObject({
  digest: v.string(),
  jobs: v.record(v.string(), JOB),
  steps: v.array(STEP),
});

// Validate duplicate keys and bound alias expansion before projecting classification metadata.
const PARSER = String.raw`
require 'psych'
require 'json'
require 'digest'
MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_AST_NODES = 100_000
MAX_EXPANDED_NODES = 250_000
MAX_EXPANDED_BYTES = 16 * 1024 * 1024
MAX_DEPTH = 256

def check(node, anchors, count, depth = 0)
  raise 'YAML nesting limit exceeded' if depth > MAX_DEPTH
  count[0] += 1
  raise 'YAML AST node limit exceeded' if count[0] > MAX_AST_NODES
  if node.is_a?(Psych::Nodes::Alias)
    raise "undefined YAML alias #{node.anchor}" unless anchors.key?(node.anchor)
    return
  end
  if node.respond_to?(:anchor) && node.anchor
    raise "duplicate YAML anchor #{node.anchor}" if anchors.key?(node.anchor)
    anchors[node.anchor] = node
  end
  if node.is_a?(Psych::Nodes::Mapping)
    seen = {}
    node.children.each_slice(2) do |k,v|
      raise 'complex YAML key' unless k.is_a?(Psych::Nodes::Scalar)
      raise "duplicate YAML key #{k.value}" if seen[k.value]
      raise 'YAML merge key' if k.value == '<<'
      seen[k.value] = true
      check(k, anchors, count, depth + 1)
      check(v, anchors, count, depth + 1)
    end
  elsif node.respond_to?(:children) && node.children
    node.children.each { |n| check(n, anchors, count, depth + 1) }
  end
end

# Compute the fully resolved size on the AST DAG before safe_load or canon can
# allocate expanded values. Memoized costs still multiply at every alias use.
def expansion(node, anchors, active, memo, depth = 0)
  raise 'YAML alias nesting limit exceeded' if depth > MAX_DEPTH
  id = node.object_id
  raise 'recursive YAML alias' if active[id]
  return memo[id] if memo.key?(id)
  active[id] = true
  if node.is_a?(Psych::Nodes::Alias)
    result = expansion(anchors.fetch(node.anchor), anchors, active, memo, depth + 1)
  else
    total = 1
    bytes = node.is_a?(Psych::Nodes::Scalar) ? node.value.bytesize : 0
    height = 1
    if node.respond_to?(:children) && node.children
      node.children.each do |child|
        child_nodes, child_bytes, child_height = expansion(child, anchors, active, memo, depth + 1)
        total += child_nodes
        bytes += child_bytes
        height = [height, child_height + 1].max
        raise 'YAML alias nesting limit exceeded' if height > MAX_DEPTH
        raise 'YAML alias expansion limit exceeded' if total > MAX_EXPANDED_NODES || bytes > MAX_EXPANDED_BYTES
      end
    end
    result = [total, bytes, height]
  end
  active.delete(id)
  memo[id] = result
end
def canon(value)
  case value
  when Hash
    value.keys.sort_by(&:to_s).to_h { |k| [k,canon(value[k])] }
  when Array
    value.map { |v| canon(v) }
  else
    value
  end
end
def steps(value)
  raise 'steps must be array' unless value.is_a?(Array)
  value.flat_map do |s|
    raise 'step must be mapping' unless s.is_a?(Hash)
    if s.key?('parallel')
      raise 'parallel group cannot have leaf fields' unless s.keys == ['parallel']
      next steps(s['parallel'])
    end
    ['uses','run'].each { |k| raise "#{k} must be string" if s.key?(k) && !s[k].is_a?(String) }
    raise 'step cannot have uses and run' if s.key?('uses') && s.key?('run')
    {'uses'=>s['uses'],'run'=>s['run']}
  end
end
# Shell text is opaque; only its secret references and publish/deploy gates enter
# the classification. Ordinary commands, names, timeouts and caches are excluded.
def secret_refs(value)
  case value
  when Hash
    value.values.flat_map { |v| secret_refs(v) }.uniq.sort
  when Array
    value.flat_map { |v| secret_refs(v) }.uniq.sort
  when String
    value.scan(/secrets(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])?/).uniq.sort
  else
    []
  end
end
def step_shapes(value)
  value.flat_map do |s|
    next step_shapes(s['parallel']) if s.key?('parallel')
    shape = {'uses'=>s['uses'], 'secrets'=>secret_refs(s)}
    if s.key?('uses') || s.fetch('run', '').match?(/publish|deploy|release|push/i)
      shape['if'] = s['if']
    end
    shape unless shape.values.all? { |v| v.nil? || v == [] }
  end.compact
end
def job_shape(job, workflow)
  runner = job['runs-on']
  matrix = job.dig('strategy', 'matrix')
  runner_matrix = {}
  if matrix.is_a?(Hash)
    JSON.generate(runner).scan(/matrix\.([A-Za-z_][A-Za-z0-9_-]*)/).flatten.each do |key|
      runner_matrix[key] = matrix[key]
      runner_matrix['include'] = matrix['include'] if matrix.key?('include')
    end
  end
  {
    'permissions'=>job.fetch('permissions', workflow['permissions']),
    'secrets'=>job['secrets'], 'secret_refs'=>secret_refs([workflow['env'], job]),
    'environment'=>job['environment'], 'uses'=>job['uses'], 'if'=>job['if'],
    'runs-on'=>runner, 'runner-matrix'=>runner_matrix,
    'steps'=>step_shapes(job.fetch('steps', []))
  }
end
def digest(value)
  Digest::SHA256.hexdigest(JSON.generate(canon(value)))
end
text = STDIN.read
raise 'YAML source byte limit exceeded' if text.bytesize > MAX_SOURCE_BYTES
tree = Psych.parse_stream(text)
raise 'one YAML document required' unless tree.children.length == 1
anchors = {}
check(tree, anchors, [0])
expansion(tree, anchors, {}, {})
data = Psych.safe_load(text, permitted_classes: [], permitted_symbols: [], aliases: true)
raise 'document must be mapping' unless data.is_a?(Hash)
jobs = {}
if data.key?('jobs')
  raise 'jobs must be nonempty mapping' unless data['jobs'].is_a?(Hash) && !data['jobs'].empty?
  data['jobs'].each do |id,j|
    raise 'job must be mapping with string id' unless id.is_a?(String) && j.is_a?(Hash)
    ss = j.key?('steps') ? steps(j['steps']) : []
    if j.key?('uses')
      raise 'job uses must be string' unless j['uses'].is_a?(String)
      ss << {'uses'=>j['uses'],'run'=>nil}
    end
    jobs[id] = {'digest'=>digest(job_shape(j, data)),'reusableWorkflow'=>j['uses'],'steps'=>ss}
  end
end
ss = []
if data.key?('runs')
  r = data['runs']
  raise 'action runs must be mapping' unless r.is_a?(Hash)
  if r['using'] == 'composite'
    ss = steps(r.fetch('steps'))
  else
    # Executable JS/container entry points are deliberately opaque boundaries.
    ss = [{'uses'=>nil,'run'=>JSON.generate(canon(r))}]
  end
end
shape = {'jobs'=>jobs.transform_values { |j| j['digest'] }, 'steps'=>step_shapes(data.dig('runs', 'steps') || []), 'using'=>data.dig('runs', 'using')}
STDOUT.write(JSON.generate({'digest'=>digest(shape),'jobs'=>jobs,'steps'=>ss}))
`;

export const parseDocument = (text: string) =>
  Result.try({
    try: () => {
      const parsed = Bun.spawnSync(["ruby", "-e", PARSER], {
        stdin: new TextEncoder().encode(text),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (parsed.exitCode !== 0) {
        throw new AdmissionError({
          message: `YAML rejected: ${new TextDecoder().decode(parsed.stderr).trim()}`,
        });
      }
      return v.parse(
        DOCUMENT,
        JSON.parse(new TextDecoder().decode(parsed.stdout)),
      );
    },
    catch: (cause) =>
      new AdmissionError({
        message: cause instanceof Error ? cause.message : "YAML parser failed",
      }),
  });
