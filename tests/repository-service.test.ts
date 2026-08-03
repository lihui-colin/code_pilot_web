import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { RepositoryService } from '../src/services/repository-service.js';

const temporaryDirectories: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-web-repositories-'));
  temporaryDirectories.push(root);
  return root;
}

function service(root: string, secret = Buffer.from('stable test secret')) {
  return new RepositoryService(
    root,
    secret,
    ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml'],
    pino({ enabled: false }),
  );
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('RepositoryService', () => {
  it('returns the workspace itself and does not scan children when the workspace is a Git repository', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, 'package.json'), '{}');
    await mkdir(path.join(root, 'child-repo', '.git'), { recursive: true });

    const listing = await service(root).list();
    expect(listing.entries).toHaveLength(1);
    expect(listing.entries[0]).toMatchObject({
      name: path.basename(root),
      relativePath: '',
      kind: 'repository',
      markers: ['git', 'node'],
    });
    expect(listing.entries.some(entry => entry.name === 'child-repo')).toBe(false);
  });

  it('recursively finds Git repositories and keeps marker order stable', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'plain'));
    await mkdir(path.join(root, 'plain', 'nested-repo', '.git'), { recursive: true });
    await mkdir(path.join(root, 'node-only'));
    await writeFile(path.join(root, 'node-only', 'package.json'), '{}');
    await mkdir(path.join(root, 'repo-z'));
    await writeFile(path.join(root, 'repo-z', 'package.json'), '{}');
    await writeFile(path.join(root, 'repo-z', '.git'), 'gitdir: elsewhere');
    await mkdir(path.join(root, 'repo-a', '.git'), { recursive: true });
    await writeFile(path.join(root, 'repo-a', 'pyproject.toml'), '');
    await mkdir(path.join(root, '.hidden', '.git'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', '.git'), { recursive: true });

    const listing = await service(root).list();
    expect(listing.entries.map(entry => entry.relativePath)).toEqual(['plain/nested-repo', 'repo-a', 'repo-z']);
    expect(listing.entries.every(entry => entry.kind === 'repository')).toBe(true);
    expect(listing.entries.find(entry => entry.name === 'repo-a')?.markers).toEqual(['git', 'python']);
    expect(listing.entries.find(entry => entry.name === 'repo-z')?.markers).toEqual(['git', 'node']);
    expect(listing.breadcrumbs).toHaveLength(1);
  });

  it('does not descend into a directory after identifying it as a Git repository', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'repository', '.git'), { recursive: true });
    await mkdir(path.join(root, 'repository', 'nested', '.git'), { recursive: true });
    const listing = await service(root).list();
    expect(listing.entries.map(entry => entry.relativePath)).toEqual(['repository']);
  });

  it('recognizes both .git directories and .git files', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'git-directory', '.git'), { recursive: true });
    await mkdir(path.join(root, 'git-file'));
    await writeFile(path.join(root, 'git-file', '.git'), 'gitdir: /tmp/example');
    expect((await service(root).list()).entries.map(entry => entry.name)).toEqual(['git-directory', 'git-file']);
  });

  it('does not expose symlinks that resolve outside the workspace', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await mkdir(path.join(outside, 'secret'));
    await symlink(path.join(outside, 'secret'), path.join(root, 'escape'));
    expect((await service(root).list()).entries).toEqual([]);
  });

  it('keeps directory IDs stable for the same secret', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'project', '.git'), { recursive: true });
    const first = await service(root).list();
    const second = await service(root).list();
    expect(first.entries[0]?.id).toBe(second.entries[0]?.id);
  });

  it('rejects a recursive scan with more than 1000 visible directories', async () => {
    const root = await makeRoot();
    await Promise.all(Array.from({ length: 1_001 }, (_, index) => mkdir(path.join(root, `dir-${index}`))));
    await expect(service(root).list()).rejects.toMatchObject({ code: 'DIRECTORY_TOO_LARGE' });
  });
});
