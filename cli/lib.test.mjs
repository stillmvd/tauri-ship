import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assetName,
  cargoName,
  compareVersions,
  latestJson,
  lockVersion,
  nextVersion,
  parseCommits,
  releaseNotes,
  repoFromEndpoint,
  setCargoVersion,
  setLockVersion,
  setPackageVersion,
} from './lib.mjs';

const log = (...rows) => rows.map(([s, b = '']) => `abc\x1f${s}\x1f${b}\x1e`).join('\n');

test('fix only → patch, release commits are ignored', () => {
  const commits = parseCommits(log(['fix(ui): keep the list in place'], ['chore(release): 0.5.1']));
  assert.equal(commits.length, 1);
  assert.deepEqual(nextVersion('0.5.1', commits).version, '0.5.2');
});

test('feat → minor, breaking → major', () => {
  assert.equal(nextVersion('0.5.1', parseCommits(log(['fix: a'], ['feat(x): b']))).version, '0.6.0');
  assert.equal(nextVersion('0.5.1', parseCommits(log(['feat!: b']))).version, '1.0.0');
  assert.equal(nextVersion('1.2.3', parseCommits(log(['fix: a', 'BREAKING CHANGE: gone']))).version, '2.0.0');
});

test('nothing to release', () => {
  assert.equal(nextVersion('0.5.1', parseCommits(log(['chore(release): 0.5.1']))), null);
});

test('notes list features, then fixes, skip chores', () => {
  const notes = releaseNotes(parseCommits(log(['fix: broken list'], ['chore: deps'], ['feat(memory): handoff'])));
  assert.equal(notes, '- Handoff\n- Broken list');
  assert.equal(releaseNotes(parseCommits(log(['chore: deps']))), '- Maintenance release');
});

test('asset name matches what GitHub stores', () => {
  assert.equal(assetName('Echo Studio', '0.6.0'), 'Echo.Studio_0.6.0_x64-setup.exe');
});

test('repo from updater endpoint', () => {
  assert.equal(
    repoFromEndpoint('https://github.com/stillmvd/echo-studio/releases/latest/download/latest.json'),
    'stillmvd/echo-studio',
  );
  assert.equal(repoFromEndpoint('https://example.com/latest.json'), null);
});

test('latest.json points at the tagged asset', () => {
  const json = latestJson({
    version: '0.6.0',
    notes: '- A',
    pubDate: '2026-10-08T00:00:00Z',
    signature: 'sig',
    repo: 'stillmvd/echo-studio',
    asset: 'Echo.Studio_0.6.0_x64-setup.exe',
  });
  assert.equal(
    json.platforms['windows-x86_64'].url,
    'https://github.com/stillmvd/echo-studio/releases/download/v0.6.0/Echo.Studio_0.6.0_x64-setup.exe',
  );
});

test('version bumps touch only the right field', () => {
  assert.equal(
    setPackageVersion('{\n  "name": "x",\n  "version": "0.5.1",\n  "dependencies": { "a": { "version": "1" } }\n}', '0.6.0'),
    '{\n  "name": "x",\n  "version": "0.6.0",\n  "dependencies": { "a": { "version": "1" } }\n}',
  );
  const cargo = '[package]\nname = "echo-studio"\nversion = "0.5.1"\n\n[dependencies]\nfoo = { version = "1" }\n';
  assert.equal(cargoName(cargo), 'echo-studio');
  assert.match(setCargoVersion(cargo, '0.6.0'), /\nversion = "0\.6\.0"\n/);
  assert.match(setCargoVersion(cargo, '0.6.0'), /foo = \{ version = "1" \}/);
  const lock = '[[package]]\nname = "echo"\nversion = "9.9.9"\n\n[[package]]\nname = "echo-studio"\nversion = "0.5.1"\n';
  const bumped = setLockVersion(lock, 'echo-studio', '0.6.0');
  assert.equal(lockVersion(bumped, 'echo-studio'), '0.6.0');
  assert.equal(lockVersion(bumped, 'echo'), '9.9.9');
});

test('compare versions', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
});
