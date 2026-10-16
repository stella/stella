import { Result, TaggedError } from "better-result";
import * as v from "valibot";

export class AdmissionError extends TaggedError("AdmissionError")<{
  message: string;
}> {}

// Only these document/job/step keys are omitted; new keys participate automatically.
// YAML comments are absent from the parsed objects. Action inputs stay intact.
export const CLASSIFICATION_EXCLUSIONS = {
  document: ["name", "run-name"],
  job: ["name", "timeout-minutes"],
  step: ["name", "timeout-minutes", "run"],
} as const;

const DOCUMENT = v.strictObject({
  digest: v.string(),
  jobs: v.record(v.string(), v.strictObject({ digest: v.string() })),
  dependencies: v.record(
    v.string(),
    v.picklist(["action", "reusable-workflow"]),
  ),
  relocatedActions: v.record(
    v.string(),
    v.array(
      v.strictObject({
        repository: v.nullable(v.string()),
        ref: v.nullable(v.string()),
        path: v.string(),
      }),
    ),
  ),
});

// Validate duplicate keys and bound alias expansion before projecting classification metadata.
const PARSER = String.raw`
require 'psych'
require 'json'
require 'digest'
EXCLUSIONS = JSON.parse(ARGV.fetch(0))
MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_AST_NODES = 100_000
MAX_EXPANDED_NODES = 250_000
MAX_EXPANDED_BYTES = 16 * 1024 * 1024
MAX_DEPTH = 256

def string_scalar(node)
  node.tag = 'tag:yaml.org,2002:str'
  node.plain = false
  node.quoted = true
  node.style = Psych::Nodes::Scalar::DOUBLE_QUOTED
end

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
  if node.is_a?(Psych::Nodes::Scalar) && node.tag.nil? && !node.quoted && node.value.match?(/\A(?:yes|no|on|off)\z/i)
    string_scalar(node)
  end
  if node.is_a?(Psych::Nodes::Mapping)
    seen = {}
    node.children.each_slice(2) do |k,v|
      raise 'complex YAML key' unless k.is_a?(Psych::Nodes::Scalar)
      raise "duplicate YAML key #{k.value}" if seen[k.value]
      raise 'YAML merge key' if k.value == '<<'
      seen[k.value] = true
      # GitHub mapping keys are strings (not YAML 1.1 booleans such as on).
      string_scalar(k)
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
      raise 'parallel group cannot have leaf fields' if s.key?('uses') || s.key?('run')
      next steps(s['parallel'])
    end
    ['uses','run'].each { |k| raise "#{k} must be string" if s.key?(k) && !s[k].is_a?(String) }
    raise 'step cannot have uses and run' if s.key?('uses') && s.key?('run')
    {'uses'=>s['uses'],'run'=>s['run'],'with'=>s['with']}
  end
end
# Run bodies remain opaque, but their secret references are retained separately.
# Everything else participates unless its owning job/step exclusion names it.
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
def project(value, scope)
  value.reject { |key,_| EXCLUSIONS.fetch(scope).include?(key) }
end
def step_shapes(value)
  value.filter_map do |s|
    shape = project(s, 'step')
    shape['parallel'] = step_shapes(s['parallel']) if s.key?('parallel')
    refs = secret_refs(s['run'])
    next if shape.empty? && refs.empty?
    {'definition'=>shape, 'run-secret-refs'=>refs}
  end
end
def job_shape(job)
  shape = project(job, 'job')
  shape['steps'] = step_shapes(job['steps']) if job.key?('steps')
  shape
end
def add_action_dependencies(dependencies, steps, relocated_actions)
  checkouts = []
  steps.each do |step|
    uses = step['uses']
    dependencies[uses] ||= 'action' if uses
    if uses&.start_with?('./')
      local_path = uses.delete_prefix('./')
      checkout = checkouts
        .select { |entry| local_path.start_with?(entry['path'] + '/') }
        .max_by { |entry| entry['path'].length }
      if checkout
        source_path = local_path.delete_prefix(checkout['path'] + '/')
        (relocated_actions[uses] ||= []) << {
          'repository'=>checkout['repository'],
          'ref'=>checkout['ref'],
          'path'=>source_path,
        }
      end
    end
    if uses&.start_with?('actions/checkout@') && step['with'].is_a?(Hash) && step['with']['path'].is_a?(String)
      checkouts << {
        'repository'=>step['with']['repository'].is_a?(String) ? step['with']['repository'] : nil,
        'ref'=>step['with']['ref'].is_a?(String) ? step['with']['ref'] : nil,
        'path'=>step['with']['path'].delete_prefix('./').delete_suffix('/'),
      }
    end
  end
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
data = Psych.safe_load(tree.to_yaml, permitted_classes: [], permitted_symbols: [], aliases: true)
raise 'document must be mapping' unless data.is_a?(Hash)
shape = project(data, 'document')
if data['runs'].is_a?(Hash) && data['runs'].key?('steps')
  shape['runs'] = data['runs'].merge('steps'=>step_shapes(data['runs']['steps']))
end
context = shape.reject { |key,_| key == 'jobs' }
jobs = {}
dependencies = {}
relocated_actions = {}
if data.key?('jobs')
  raise 'jobs must be nonempty mapping' unless data['jobs'].is_a?(Hash) && !data['jobs'].empty?
  data['jobs'].each do |id,j|
    raise 'job must be mapping with string id' unless id.is_a?(String) && j.is_a?(Hash)
    ss = j.key?('steps') ? steps(j['steps']) : []
    if j.key?('uses')
      raise 'job uses must be string' unless j['uses'].is_a?(String)
      dependencies[j['uses']] = 'reusable-workflow'
    end
    add_action_dependencies(dependencies, ss, relocated_actions)
    jobs[id] = {'digest'=>digest({'document'=>context, 'job'=>job_shape(j)})}
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
add_action_dependencies(dependencies, ss, relocated_actions)
shape['jobs'] = jobs.transform_values { |j| j['digest'] } if data.key?('jobs')
STDOUT.write(JSON.generate({'digest'=>digest(shape),'jobs'=>jobs,'dependencies'=>dependencies,'relocatedActions'=>relocated_actions}))
`;

export const parseDocument = (text: string) =>
  Result.try({
    try: () => {
      const parsed = Bun.spawnSync(
        ["ruby", "-e", PARSER, JSON.stringify(CLASSIFICATION_EXCLUSIONS)],
        {
          stdin: new TextEncoder().encode(text),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15_000,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
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
