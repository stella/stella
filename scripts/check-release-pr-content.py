#!/usr/bin/env python3
"""Fail closed when a release PR contains changes outside versioning output."""

import json
import re
import subprocess
import sys
from pathlib import Path


MANIFEST_PATH = re.compile(r"(?:package.json|(?:apps|packages)/[^/]+/package.json)")
SEMVER = re.compile(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?")
BLOB_BATCH_SIZE = 40


class ReleaseContentError(Exception):
    pass


def parse_lock(text):
    # Bun's text lockfile is JSON with trailing commas. Preserve string contents.
    tokens = re.split(r'("(?:\\.|[^"\\])*"|\s+)', text)
    following = ''
    for index in range(len(tokens) - 1, -1, -1):
        token = tokens[index]
        if token.endswith(',') and following in ('}', ']'):
            tokens[index] = token = token[:-1]
        if token.strip():
            following = token.lstrip()[0]
    return json.loads(''.join(tokens))


def validate(files, read):
    manifests = {}
    for item in files:
        name = item['filename']
        if MANIFEST_PATH.fullmatch(name):
            if item['status'] != 'modified':
                raise ReleaseContentError(f'{name}: versioning cannot add or remove a package')
            before, after = (json.loads(read(side, name)) for side in ('base', 'head'))
            manifests[name] = (before, after)
    versions = {after['name']: after.get('version') for _, after in manifests.values()}
    for item in files:
        name, status = item['filename'], item['status']
        if status == 'renamed':
            raise ReleaseContentError(f'{name}: versioning cannot rename files')
        if name in manifests:
            before, after = manifests[name]
            if ('version' in before) != ('version' in after):
                raise ReleaseContentError(f'{name}: versioning cannot add or remove a version field')
            for package in (before, after):
                if 'version' in package and (not isinstance(package['version'], str) or not SEMVER.fullmatch(package['version'])):
                    raise ReleaseContentError(f'{name}: expected a package version')
            before, after = before.copy(), after.copy()
            before.pop('version', None)
            after.pop('version', None)
            for section in ('dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'):
                old_dependencies, new_dependencies = before.get(section, {}), after.get(section, {}).copy()
                for dependency, new in new_dependencies.items():
                    old = old_dependencies.get(dependency)
                    if old == new:
                        continue
                    version = versions.get(dependency)
                    if not isinstance(old, str) or not isinstance(version, str):
                        continue
                    match = re.fullmatch(r'((?:workspace:)?[~^]?)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', old)
                    if match is None:
                        continue
                    prefix = match.group(1)
                    if new == prefix + version:
                        new_dependencies[dependency] = old
                if section in after:
                    after[section] = new_dependencies
            if before != after:
                raise ReleaseContentError(f'{name}: only package versions and versioned internal dependencies may change')
            continue
        if name == 'bun.lock' and status == 'modified':
            before, after = (parse_lock(read(side, name)) for side in ('base', 'head'))
            for workspace, entry in after.get('workspaces', {}).items():
                previous = before.get('workspaces', {}).get(workspace, {})
                if entry.get('version') == previous.get('version'):
                    continue
                manifest = manifests.get(f'{workspace}/package.json')
                if manifest is None or entry.get('version') != manifest[1].get('version'):
                    raise ReleaseContentError(f'{name}: workspace version has no matching package version')
                entry['version'] = previous.get('version')
            if before != after:
                raise ReleaseContentError(f'{name}: only generated workspace versions may change')
            continue
        if name == 'packages/cli/src/generated/cli-version.ts' and status == 'modified':
            manifest = manifests.get('packages/cli/package.json')
            if manifest is None:
                raise ReleaseContentError(f'{name}: generated CLI version has no matching package version')
            old, new = (json.dumps(package['version']) for package in manifest)
            before, after = (read(side, name) for side in ('base', 'head'))
            expected = before.replace(f'export const CLI_VERSION = {old};', f'export const CLI_VERSION = {new};')
            if expected == before or after != expected:
                raise ReleaseContentError(f'{name}: only the generated CLI version may change')
            continue
        if re.fullmatch(r'\.changeset/[^/]+\.md', name) and name != '.changeset/README.md' and status == 'removed':
            continue
        if name == 'VERSION' and status == 'modified':
            if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n?', read('head', name)):
                raise ReleaseContentError('VERSION: expected a release version')
            continue
        if re.fullmatch(r'(?:(?:apps|packages)/[^/]+/)?CHANGELOG\.md|docs/changelog/[^/]+\.md', name) and status in ('added', 'modified'):
            continue
        if name == 'apps/landing/src/data/changelog-release-dates.json' and status == 'modified':
            json.loads(read('head', name))
            continue
        raise ReleaseContentError(f'{name}: not a versioning output ({status})')


def github_json(endpoint, *options):
    return json.loads(subprocess.check_output(['bash', str(Path(__file__).with_name('gh-retry.sh')), 'api', endpoint, *options], text=True))


def main():
    repo, number = sys.argv[1:]
    pull = github_json(f'repos/{repo}/pulls/{number}')
    if pull['draft'] or pull['base']['ref'] != 'main' or pull['head']['repo']['full_name'] != repo or not pull['title'].startswith('chore: release v'):
        raise ReleaseContentError('release identity changed during recognition')
    revisions = {side: pull[side]['sha'] for side in ('base', 'head')}
    comparison = github_json(f"repos/{repo}/compare/{revisions['base']}...{revisions['head']}")
    revisions['base'] = comparison['merge_base_commit']['sha']
    pages = github_json(f'repos/{repo}/pulls/{number}/files?per_page=100', '--paginate', '--slurp')
    files = [item for page in pages for item in page]
    if len(files) != pull['changed_files']:
        raise ReleaseContentError('incomplete release file listing')

    owner, name = repo.split('/')
    paths = sorted({item['filename'] for item in files if
                    MANIFEST_PATH.fullmatch(item['filename'])
                    or item['filename'] in ('VERSION', 'bun.lock', 'packages/cli/src/generated/cli-version.ts',
                                            'apps/landing/src/data/changelog-release-dates.json')})
    requests = [(side, path) for path in paths for side in ('base', 'head')]
    contents = {}
    for start in range(0, len(requests), BLOB_BATCH_SIZE):
        batch = requests[start:start + BLOB_BATCH_SIZE]
        fields = ' '.join(f'blob{index}: object(expression: {json.dumps(revisions[side] + ":" + path)}) {{ ... on Blob {{ text }} }}'
                          for index, (side, path) in enumerate(batch))
        query = f'query {{ repository(owner: {json.dumps(owner)}, name: {json.dumps(name)}) {{ {fields} }} }}'
        response = github_json('graphql', '-f', f'query={query}')
        if response.get('errors'):
            raise ReleaseContentError('failed to read immutable release file contents')
        blobs = response['data']['repository']
        for index, request in enumerate(batch):
            blob = blobs.get(f'blob{index}')
            if blob is None or not isinstance(blob.get('text'), str):
                raise ReleaseContentError(f'{request[1]}: unavailable file contents')
            contents[request] = blob['text']

    def read(side, path):
        return contents[(side, path)]

    validate(files, read)
    current = github_json(f'repos/{repo}/pulls/{number}')
    if any(current[side]['sha'] != pull[side]['sha'] for side in ('base', 'head')):
        raise ReleaseContentError('release PR changed during content validation; retry at the new head')


if __name__ == '__main__':
    try:
        main()
    except (ReleaseContentError, KeyError, ValueError, subprocess.CalledProcessError) as error:
        print(f'release PR content guard: {error}', file=sys.stderr)
        sys.exit(1)
