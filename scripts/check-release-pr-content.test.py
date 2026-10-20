#!/usr/bin/env python3
"""Exercise the release boundary with actual repository versioning output."""
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release_content', ROOT / 'scripts/check-release-pr-content.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def check(before, after):
    paths = before.keys() | after.keys()
    files = [
        {'filename': name, 'status': 'removed' if name not in after else 'added' if name not in before else 'modified'}
        for name in sorted(paths) if before.get(name) != after.get(name)
    ]
    guard.validate(files, lambda side, name: (before if side == 'base' else after)[name])


def refuses(before, after, expected):
    try:
        check(before, after)
    except guard.ReleaseContentError as error:
        assert expected in str(error), str(error)
        return
    raise AssertionError(f'guard accepted forbidden change: {expected}')


# Enumerate every tracked non-output path: an allowlist widening cannot silently
# admit a source, configuration, workflow, or newly added package path.
tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
for name in tracked:
    if not name or name.endswith('/CHANGELOG.md') or name == 'CHANGELOG.md' or name.startswith('docs/changelog/'):
        continue
    if name == 'VERSION' or name == 'bun.lock' or name == 'apps/landing/src/data/changelog-release-dates.json' or name == 'packages/cli/src/generated/cli-version.ts' or name.endswith('/package.json') or name == 'package.json':
        continue
    refuses({name: 'old'}, {name: 'new'}, name)
for name in ('.changeset/new.md', '.changeset/README.md', '.github/workflows/new.yml', 'packages/new/package.json', 'docs/changelog/nested/source.ts'):
    refuses({}, {name: '{}'}, name)
for name in ('.changeset/consumed.md',):
    check({name: '---\n"@stll/cli": patch\n---\n'}, {})

manifest = {'name': '@stll/cli', 'version': '1.0.0', 'scripts': {'build': 'safe'}}
base = {'packages/cli/package.json': json.dumps(manifest)}
refuses(base, {'packages/cli/package.json': json.dumps({key: value for key, value in manifest.items() if key != 'version'})}, 'cannot add or remove a version field')
refuses(base, {'packages/cli/package.json': json.dumps({**manifest, 'version': '1.0.1', 'scripts': {'build': 'unsafe'}})}, 'only package versions')

# The API boundary must read the merge base, batch immutable blobs, and refuse
# a file listing that raced a pull-request update.
api_files = [{'filename': f'packages/fixture{index}/package.json', 'status': 'modified'} for index in range(25)]
api_calls = []
head_changed = False
api_failure = False
metadata_calls = 0


def api(endpoint, *options):
    global metadata_calls
    if endpoint == 'repos/stella/stella/pulls/12':
        metadata_calls += 1
        return {'draft': False, 'title': 'chore: release v1.2.3', 'base': {'sha': 'base-tip', 'ref': 'main'},
                'head': {'sha': 'changed-head' if head_changed and metadata_calls > 1 else 'head-sha', 'repo': {'full_name': 'stella/stella'}},
                'changed_files': len(api_files)}
    if endpoint == 'repos/stella/stella/compare/base-tip...head-sha':
        return {'merge_base_commit': {'sha': 'merge-base'}}
    if endpoint == 'repos/stella/stella/pulls/12/files?per_page=100':
        return [api_files[:10], api_files[10:]]
    assert endpoint == 'graphql', endpoint
    if api_failure:
        return {'errors': [{'message': 'unavailable blob'}]}
    query = options[1].removeprefix('query=')
    expressions = re.findall(r'blob(\d+): object\(expression: ("[^"\n]+")\)', query)
    api_calls.append(len(expressions))
    blobs = {}
    for alias, expression in expressions:
        revision, name = json.loads(expression).split(':', 1)
        assert revision in ('merge-base', 'head-sha'), revision
        blobs[f'blob{alias}'] = {'text': json.dumps({'name': name, 'version': '1.0.0' if revision == 'merge-base' else '1.0.1'})}
    return {'data': {'repository': blobs}}


original_api, original_argv = guard.github_json, sys.argv
try:
    guard.github_json = api
    sys.argv = ['check-release-pr-content.py', 'stella/stella', '12']
    guard.main()
    assert api_calls == [40, 10], api_calls
    head_changed = True
    metadata_calls = 0
    try:
        guard.main()
    except guard.ReleaseContentError as error:
        assert 'changed during content validation' in str(error), error
    else:
        raise AssertionError('guard accepted a release PR that changed during validation')
    head_changed = False
    metadata_calls = 0
    api_failure = True
    try:
        guard.main()
    except guard.ReleaseContentError as error:
        assert 'failed to read immutable' in str(error), error
    else:
        raise AssertionError('guard accepted failed immutable blob reads')
finally:
    guard.github_json, sys.argv = original_api, original_argv

with tempfile.TemporaryDirectory(prefix='stella-release-output-') as temporary:
    root = Path(temporary)
    inputs = ['package.json', 'bun.lock', '.changeset/config.json',
              'scripts/sync-lockfile-workspace-versions.ts', 'scripts/lockfile-workspace-versions.ts', 'scripts/json-text-edit.ts',
              'packages/cli/src/codegen-version.ts', 'packages/cli/src/generated/cli-version.ts']
    inputs += [name for name in tracked if name.endswith('/package.json') and len(Path(name).parts) == 3 and Path(name).parts[0] in ('apps', 'packages')]
    for name in inputs:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
    subprocess.run(['git', 'add', '.'], cwd=root, check=True)
    subprocess.run(['git', '-c', 'user.name=Release test', '-c', 'user.email=release-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], cwd=root, check=True)
    # Uncommitted changesets avoid any remote changelog metadata lookup; the real
    # configured changelog plugin and complete version command still execute.
    (root / '.changeset/content-guard-test.md').write_text('---\n"@stll/cli": patch\n---\n\nRelease output boundary test.\n')
    subprocess.run(['git', 'add', '.changeset/content-guard-test.md'], cwd=root, check=True)

    def snapshot():
        return {str(path.relative_to(root)): path.read_text() for path in root.rglob('*')
                if path.is_file() and '.git' not in path.relative_to(root).parts and 'node_modules' not in path.relative_to(root).parts}

    before = snapshot()
    subprocess.run(['bun', 'run', 'changeset:version'], cwd=root, check=True, env={**os.environ, 'GITHUB_TOKEN': '', 'GH_TOKEN': ''})
    after = snapshot()
    changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
    assert 'packages/cli/package.json' in changed, changed
    assert '.changeset/content-guard-test.md' in changed, changed
    assert 'bun.lock' in changed, changed
    assert 'packages/cli/src/generated/cli-version.ts' in changed, changed
    check(before, after)
    for name in ('packages/cli/package.json', 'bun.lock'):
        bad = after.copy()
        data = guard.parse_lock(bad[name]) if name == 'bun.lock' else json.loads(bad[name])
        data['injected'] = 'not versioning output'
        bad[name] = json.dumps(data)
        refuses(before, bad, name)
    bad = after.copy()
    bad['packages/cli/src/generated/cli-version.ts'] += '\nconsole.log("injected");\n'
    refuses(before, bad, 'only the generated CLI version')
print('ok   release content boundary and real versioning output')
