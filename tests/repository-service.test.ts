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

async function folderIdFor(serviceInstance: RepositoryService, targetPath: string): Promise<string> {
  let listing = await serviceInstance.listFolders();
  for (const segment of targetPath.split(path.sep).filter(Boolean)) {
    const child = listing.entries.find(entry => entry.name === segment);
    if (!child) throw new Error(`Folder segment was not listed: ${segment}`);
    listing = await serviceInstance.listFolders(child.id);
  }
  return listing.current.id;
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

  it('browses the server with opaque folder IDs and persists a selected external Git repository', async () => {
    const root = await makeRoot();
    const workspace = path.join(root, 'workspace');
    const external = path.join(root, 'external-repository');
    await mkdir(workspace);
    await mkdir(path.join(external, '.git'), { recursive: true });
    const persisted: string[][] = [];
    const repositoryService = new RepositoryService(
      workspace,
      Buffer.from('stable test secret'),
      ['.git', 'package.json'],
      pino({ enabled: false }),
      [],
      async paths => { persisted.push([...paths]); },
    );

    const externalFolderId = await folderIdFor(repositoryService, external);
    expect(externalFolderId).toMatch(/^folder_[A-Za-z0-9_-]{43}$/u);
    const repositoryId = await repositoryService.addManualRepository(externalFolderId);
    const listing = await repositoryService.list();

    expect(persisted).toEqual([[external]]);
    expect(listing.entries).toContainEqual(expect.objectContaining({
      id: repositoryId,
      name: 'external-repository',
      relativePath: external,
      source: 'manual',
      markers: ['git'],
    }));
    await expect(repositoryService.resolveRepository(repositoryId)).resolves.toEqual({
      realPath: external,
      relativePath: external,
    });

    await repositoryService.removeManualRepository(repositoryId);
    expect(persisted.at(-1)).toEqual([]);
    expect((await repositoryService.list()).entries).toEqual([]);
  });

  it('allows a non-Git folder to be selected and persisted', async () => {
    const root = await makeRoot();
    const workspace = path.join(root, 'workspace');
    const plain = path.join(root, 'plain-directory');
    await mkdir(workspace);
    await mkdir(plain);
    const persisted: string[][] = [];
    const repositoryService = new RepositoryService(
      workspace,
      Buffer.from('stable test secret'),
      ['.git', 'package.json'],
      pino({ enabled: false }),
      [],
      async paths => { persisted.push([...paths]); },
    );
    const folderId = await folderIdFor(repositoryService, plain);
    const directoryId = await repositoryService.addManualRepository(folderId);
    expect((await repositoryService.list()).entries).toContainEqual(expect.objectContaining({
      id: directoryId,
      kind: 'directory',
      source: 'manual',
      markers: [],
    }));
    expect(persisted).toEqual([[plain]]);
  });

  it('lists repository context files with opaque IDs and revalidates containment before reading', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'app.ts'), 'export const answer = 42;\n');
    await writeFile(path.join(root, 'src', 'changes-later.txt'), 'text for now');
    await writeFile(path.join(root, 'src', 'binary.dat'), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat((128 * 1024) + 1));
    await writeFile(path.join(root, '.git', 'config'), 'secret');
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'linked-secret.txt'));
    const repositoryService = service(root);
    const repositoryId = (await repositoryService.list()).entries[0]!.id;

    const listing = await repositoryService.listContextFiles(repositoryId);
    expect(listing.truncated).toBe(false);
    expect(listing.files.map(file => file.relativePath)).toEqual(['src/app.ts', 'src/changes-later.txt']);
    expect(listing.files.every(file => /^file_[A-Za-z0-9_-]{43}$/u.test(file.id))).toBe(true);
    const sourceFile = listing.files.find(file => file.relativePath === 'src/app.ts')!;
    await expect(repositoryService.resolveContextFiles(repositoryId, [sourceFile.id])).resolves.toEqual([{
      relativePath: 'src/app.ts',
      content: 'export const answer = 42;\n',
    }]);
    const changingFile = listing.files.find(file => file.relativePath === 'src/changes-later.txt')!;
    await writeFile(path.join(root, 'src', 'changes-later.txt'), Buffer.from([1, 0, 2]));
    await expect(repositoryService.resolveContextFiles(repositoryId, [changingFile.id]))
      .rejects.toMatchObject({ code: 'CONTEXT_FILE_BINARY' });
    await expect(repositoryService.resolveContextFiles(repositoryId, [`file_${'a'.repeat(43)}`]))
      .rejects.toMatchObject({ code: 'CONTEXT_FILE_NOT_FOUND' });

    await rm(path.join(root, 'src', 'app.ts'));
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'src', 'app.ts'));
    await expect(repositoryService.resolveContextFiles(repositoryId, [sourceFile.id]))
      .rejects.toMatchObject({ code: 'CONTEXT_FILE_NOT_FOUND' });
  });
});
