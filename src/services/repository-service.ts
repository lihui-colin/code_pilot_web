import { createHmac } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import type {
  DirectoryEntry,
  DirectoryLocation,
  ProjectMarker,
  RepositoryFolderListing,
  RepositoryContextFileListing,
  RepositoryListing,
  RepositorySource,
} from '../domain/types.js';
import { ApiError } from '../errors.js';

const markerMap = new Map<string, ProjectMarker>([
  ['.git', 'git'],
  ['package.json', 'node'],
  ['pyproject.toml', 'python'],
  ['Cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['pom.xml', 'java'],
]);
const markerOrder: ProjectMarker[] = ['git', 'node', 'python', 'rust', 'go', 'java'];
const ignoredDirectoryNames = new Set(['node_modules', 'target', 'dist', 'build', 'vendor', '.cache']);
const maxScannedDirectories = 1_000;
const ignoredContextDirectoryNames = new Set([...ignoredDirectoryNames, '.git']);
const maxContextFileListing = 5_000;
const maxContextDirectories = 2_000;
const maxContextFilesPerTurn = 8;
const maxContextFileBytes = 128 * 1024;
const maxContextTotalBytes = 512 * 1024;

interface RegisteredRepository {
  source: RepositorySource;
  relativePath: string;
  configuredPath: string;
}

interface RegisteredContextFile {
  repositoryId: string;
  relativePath: string;
}

export interface ResolvedContextFile {
  relativePath: string;
  content: string;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiError(504, 'DIRECTORY_READ_TIMEOUT', 'Directory read timed out')), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isContained(rootRealPath: string, targetRealPath: string): boolean {
  const boundary = path.relative(rootRealPath, targetRealPath);
  return boundary !== '..' && !boundary.startsWith(`..${path.sep}`) && !path.isAbsolute(boundary);
}

function decodeContextText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

export class RepositoryService {
  private readonly repositoryIndex = new Map<string, RegisteredRepository>();
  private readonly folderIndex = new Map<string, string>();
  private readonly contextFileIndex = new Map<string, RegisteredContextFile>();
  private readonly manualRepositoryPaths = new Set<string>();
  private readonly fileSystemRoot: string;

  constructor(
    private readonly workspaceRootRealPath: string,
    private readonly directoryIdSecret: Buffer,
    private readonly configuredMarkers: readonly string[],
    private readonly logger: FastifyBaseLogger,
    manualRepositoryPaths: readonly string[] = [],
    private readonly persistManualRepositoryPaths: (paths: readonly string[]) => Promise<void> = async () => undefined,
  ) {
    for (const repositoryPath of manualRepositoryPaths) this.manualRepositoryPaths.add(repositoryPath);
    this.fileSystemRoot = path.parse(workspaceRootRealPath).root;
  }

  private idFor(relativePath: string): string {
    return `dir_${createHmac('sha256', this.directoryIdSecret).update(relativePath).digest('base64url')}`;
  }

  private manualIdFor(realPath: string): string {
    return `dir_${createHmac('sha256', this.directoryIdSecret).update(`manual:${realPath}`).digest('base64url')}`;
  }

  private folderIdFor(realPath: string): string {
    return `folder_${createHmac('sha256', this.directoryIdSecret).update(`folder:${realPath}`).digest('base64url')}`;
  }

  private contextFileIdFor(repositoryId: string, relativePath: string): string {
    return `file_${createHmac('sha256', this.directoryIdSecret)
      .update(`context:${repositoryId}:${relativePath}`)
      .digest('base64url')}`;
  }

  private registerFolder(realPath: string): string {
    const id = this.folderIdFor(realPath);
    this.folderIndex.set(id, realPath);
    return id;
  }

  private async resolveContained(rootRealPath: string, candidate: string): Promise<string> {
    let targetRealPath: string;
    try {
      targetRealPath = await realpath(candidate);
    } catch {
      throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    }
    if (!isContained(rootRealPath, targetRealPath)) {
      throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    }
    return targetRealPath;
  }

  private resolveWorkspace(relativePath: string): Promise<string> {
    return this.resolveContained(this.workspaceRootRealPath, path.resolve(this.workspaceRootRealPath, relativePath));
  }

  private resolveFileSystem(candidate: string): Promise<string> {
    return this.resolveContained(this.fileSystemRoot, candidate);
  }

  private async detectMarkers(directoryRealPath: string): Promise<ProjectMarker[]> {
    const detected = new Set<ProjectMarker>();
    const markerNames = new Set(['.git', ...this.configuredMarkers]);
    await Promise.all([...markerNames].map(async markerName => {
      const marker = markerMap.get(markerName);
      if (!marker) return;
      try {
        await stat(path.join(directoryRealPath, markerName));
        detected.add(marker);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') {
          this.logger.warn({ marker: markerName, errorCode: code }, 'repository marker check failed');
        }
      }
    }));
    return markerOrder.filter(marker => detected.has(marker));
  }

  private rootLocation(): DirectoryLocation {
    return { id: null, name: path.basename(this.workspaceRootRealPath), relativePath: '' };
  }

  async list(): Promise<RepositoryListing> {
    return withTimeout(this.scanRepositories(), 5_000);
  }

  async resolveRepository(repositoryId: string): Promise<{ realPath: string; relativePath: string }> {
    if (!this.repositoryIndex.has(repositoryId)) await this.list();
    const registered = this.repositoryIndex.get(repositoryId);
    if (!registered) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    const realPath = registered.source === 'workspace'
      ? await this.resolveWorkspace(registered.relativePath)
      : await this.resolveFileSystem(registered.configuredPath);
    if (!(await stat(realPath)).isDirectory()) {
      throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    }
    return { realPath, relativePath: registered.relativePath };
  }

  async listContextFiles(repositoryId: string): Promise<RepositoryContextFileListing> {
    return withTimeout(this.scanContextFiles(repositoryId), 5_000);
  }

  async resolveContextFiles(repositoryId: string, fileIds: readonly string[]): Promise<ResolvedContextFile[]> {
    if (fileIds.length > maxContextFilesPerTurn) {
      throw new ApiError(400, 'TOO_MANY_CONTEXT_FILES', 'Too many context files were selected');
    }
    if (fileIds.length === 0) return [];
    if (fileIds.some(fileId => !this.contextFileIndex.has(fileId))) await this.listContextFiles(repositoryId);
    const repository = await this.resolveRepository(repositoryId);
    const resolved: ResolvedContextFile[] = [];
    let totalBytes = 0;
    for (const fileId of fileIds) {
      const registered = this.contextFileIndex.get(fileId);
      if (!registered || registered.repositoryId !== repositoryId) {
        throw new ApiError(404, 'CONTEXT_FILE_NOT_FOUND', 'Context file was not found');
      }
      let fileRealPath: string;
      try {
        fileRealPath = await this.resolveContained(
          repository.realPath,
          path.resolve(repository.realPath, registered.relativePath),
        );
      } catch {
        throw new ApiError(404, 'CONTEXT_FILE_NOT_FOUND', 'Context file was not found');
      }
      const fileStat = await stat(fileRealPath);
      if (!fileStat.isFile()) throw new ApiError(404, 'CONTEXT_FILE_NOT_FOUND', 'Context file was not found');
      if (fileStat.size > maxContextFileBytes || totalBytes + fileStat.size > maxContextTotalBytes) {
        throw new ApiError(422, 'CONTEXT_FILE_TOO_LARGE', 'Selected context files are too large');
      }
      const buffer = await readFile(fileRealPath);
      if (buffer.length > maxContextFileBytes || totalBytes + buffer.length > maxContextTotalBytes) {
        throw new ApiError(422, 'CONTEXT_FILE_TOO_LARGE', 'Selected context files are too large');
      }
      const content = decodeContextText(buffer);
      if (content === null) throw new ApiError(422, 'CONTEXT_FILE_BINARY', 'Binary files cannot be used as context');
      totalBytes += buffer.length;
      resolved.push({ relativePath: registered.relativePath, content });
    }
    return resolved;
  }

  async listFolders(directoryId?: string, initialPath?: string): Promise<RepositoryFolderListing> {
    return withTimeout(this.readFolder(directoryId, initialPath), 5_000);
  }

  async addManualRepository(directoryId: string): Promise<string> {
    const configuredPath = this.folderIndex.get(directoryId);
    if (!configuredPath) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    const realPath = await this.resolveFileSystem(configuredPath);
    if (!(await stat(realPath)).isDirectory()) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    await this.list();
    const existing = [...this.repositoryIndex.entries()].find(([, repository]) => repository.configuredPath === realPath);
    if (existing) return existing[0];
    if (!this.manualRepositoryPaths.has(realPath)) {
      const paths = [...this.manualRepositoryPaths, realPath];
      await this.persistManualRepositoryPaths(paths);
      this.manualRepositoryPaths.add(realPath);
    }
    await this.list();
    const matching = [...this.repositoryIndex.entries()].find(([, repository]) => repository.configuredPath === realPath);
    if (!matching) throw new ApiError(500, 'REPOSITORY_STATE_FAILED', 'Repository could not be added');
    return matching[0];
  }

  async removeManualRepository(repositoryId: string): Promise<void> {
    await this.list();
    const registered = this.repositoryIndex.get(repositoryId);
    if (!registered || registered.source !== 'manual' || !this.manualRepositoryPaths.has(registered.configuredPath)) {
      throw new ApiError(404, 'MANUAL_REPOSITORY_NOT_FOUND', 'Manual repository was not found');
    }
    const paths = [...this.manualRepositoryPaths].filter(candidate => candidate !== registered.configuredPath);
    await this.persistManualRepositoryPaths(paths);
    this.manualRepositoryPaths.delete(registered.configuredPath);
    this.repositoryIndex.delete(repositoryId);
  }

  private async readFolder(directoryId?: string, initialPath?: string): Promise<RepositoryFolderListing> {
    const configuredPath = initialPath !== undefined
      ? path.resolve(this.fileSystemRoot, initialPath)
      : directoryId === undefined
        ? this.fileSystemRoot
        : this.folderIndex.get(directoryId);
    if (!configuredPath) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    const currentRealPath = await this.resolveFileSystem(configuredPath);
    if (!(await stat(currentRealPath)).isDirectory()) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    const currentId = this.registerFolder(currentRealPath);
    const parentRealPath = path.dirname(currentRealPath);
    const parentId = parentRealPath === currentRealPath ? null : this.registerFolder(parentRealPath);
    let children;
    try {
      children = await readdir(currentRealPath, { withFileTypes: true });
    } catch {
      throw new ApiError(403, 'DIRECTORY_NOT_READABLE', 'Directory cannot be read');
    }
    if (children.length > maxScannedDirectories) {
      throw new ApiError(422, 'DIRECTORY_TOO_LARGE', 'Directory contains too many entries');
    }
    const entries = [] as RepositoryFolderListing['entries'];
    const visited = new Set<string>();
    for (const child of children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      try {
        const childRealPath = await this.resolveFileSystem(path.join(currentRealPath, child.name));
        if (visited.has(childRealPath) || !(await stat(childRealPath)).isDirectory()) continue;
        visited.add(childRealPath);
        entries.push({
          id: this.registerFolder(childRealPath),
          name: child.name,
          gitRepository: (await this.detectMarkers(childRealPath)).includes('git'),
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (error instanceof ApiError || code === 'ENOENT' || code === 'EACCES') continue;
        throw error;
      }
    }
    return {
      current: {
        id: currentId,
        name: currentRealPath === this.fileSystemRoot ? this.fileSystemRoot : path.basename(currentRealPath),
        relativePath: path.relative(this.fileSystemRoot, currentRealPath).split(path.sep).join('/'),
        gitRepository: (await this.detectMarkers(currentRealPath)).includes('git'),
      },
      parentId,
      entries,
    };
  }

  private async scanContextFiles(repositoryId: string): Promise<RepositoryContextFileListing> {
    const repository = await this.resolveRepository(repositoryId);
    for (const [fileId, registered] of this.contextFileIndex) {
      if (registered.repositoryId === repositoryId) this.contextFileIndex.delete(fileId);
    }
    const files: RepositoryContextFileListing['files'] = [];
    const queue = [{ realPath: repository.realPath, relativePath: '' }];
    let truncated = false;
    let scannedDirectories = 0;
    while (queue.length > 0 && !truncated) {
      const current = queue.shift();
      if (!current) break;
      scannedDirectories += 1;
      if (scannedDirectories > maxContextDirectories) {
        truncated = true;
        break;
      }
      let children;
      try {
        children = await readdir(current.realPath, { withFileTypes: true });
      } catch {
        continue;
      }
      children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        const relativePath = current.relativePath
          ? path.join(current.relativePath, child.name)
          : child.name;
        const candidate = path.join(current.realPath, child.name);
        if (child.isDirectory()) {
          if (!ignoredContextDirectoryNames.has(child.name)) {
            queue.push({ realPath: candidate, relativePath });
          }
          continue;
        }
        if (!child.isFile()) continue;
        try {
          const fileRealPath = await this.resolveContained(repository.realPath, candidate);
          const fileStat = await stat(fileRealPath);
          if (!fileStat.isFile() || fileStat.size > maxContextFileBytes) continue;
          const buffer = await readFile(fileRealPath);
          if (buffer.length > maxContextFileBytes || decodeContextText(buffer) === null) continue;
          const normalizedRelativePath = relativePath.split(path.sep).join('/');
          const id = this.contextFileIdFor(repositoryId, normalizedRelativePath);
          this.contextFileIndex.set(id, { repositoryId, relativePath: normalizedRelativePath });
          files.push({ id, relativePath: normalizedRelativePath, size: fileStat.size });
          if (files.length >= maxContextFileListing) {
            truncated = true;
            break;
          }
        } catch {
          // Skip files that disappear, become unreadable, or resolve outside the repository.
        }
      }
    }
    return { files, truncated };
  }

  private async scanRepositories(): Promise<RepositoryListing> {
    const currentRealPath = await this.resolveWorkspace('');
    const root = this.rootLocation();
    const entries: DirectoryEntry[] = [];
    const rootMarkers = await this.detectMarkers(currentRealPath);
    if (rootMarkers.includes('git')) {
      entries.push({
        id: this.idFor(''),
        name: root.name,
        relativePath: '',
        kind: 'repository',
        source: 'workspace',
        markers: rootMarkers,
        viewer: null,
        session: null,
      });
    } else {
      await this.scanWorkspaceChildren(currentRealPath, entries);
    }

    const knownRealPaths = new Set<string>();
    for (const entry of entries) {
      knownRealPaths.add(await this.resolveWorkspace(entry.relativePath));
    }
    for (const configuredPath of this.manualRepositoryPaths) {
      try {
        const realPath = await this.resolveFileSystem(configuredPath);
        if (knownRealPaths.has(realPath) || !(await stat(realPath)).isDirectory()) continue;
        const markers = await this.detectMarkers(realPath);
        knownRealPaths.add(realPath);
        entries.push({
          id: this.manualIdFor(realPath),
          name: path.basename(realPath),
          relativePath: realPath,
          kind: markers.includes('git') ? 'repository' : 'directory',
          source: 'manual',
          markers,
          viewer: null,
          session: null,
        });
      } catch (error) {
        this.logger.warn({ errorCode: (error as NodeJS.ErrnoException).code }, 'skipped unavailable manual repository');
      }
    }

    entries.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
    this.repositoryIndex.clear();
    for (const entry of entries) {
      this.repositoryIndex.set(entry.id, {
        source: entry.source,
        relativePath: entry.relativePath,
        configuredPath: entry.source === 'workspace'
          ? path.resolve(this.workspaceRootRealPath, entry.relativePath)
          : entry.relativePath,
      });
    }
    return { current: root, breadcrumbs: [root], entries };
  }

  private async scanWorkspaceChildren(currentRealPath: string, entries: DirectoryEntry[]): Promise<void> {
    let children;
    try {
      children = await readdir(currentRealPath, { withFileTypes: true });
    } catch {
      throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    }
    const queue = children
      .filter(child => !child.name.startsWith('.') && !ignoredDirectoryNames.has(child.name))
      .filter(child => child.isDirectory() || child.isSymbolicLink())
      .map(child => child.name)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const visitedRealPaths = new Set([currentRealPath]);
    let scannedDirectories = 0;
    while (queue.length > 0) {
      const childRelativePath = queue.shift();
      if (childRelativePath === undefined) break;
      scannedDirectories += 1;
      if (scannedDirectories > maxScannedDirectories) {
        throw new ApiError(422, 'DIRECTORY_TOO_LARGE', 'Directory contains too many entries');
      }
      try {
        const childRealPath = await this.resolveWorkspace(childRelativePath);
        if (visitedRealPaths.has(childRealPath)) continue;
        visitedRealPaths.add(childRealPath);
        if (!(await stat(childRealPath)).isDirectory()) continue;
        const markers = await this.detectMarkers(childRealPath);
        if (markers.includes('git')) {
          entries.push({
            id: this.idFor(childRelativePath),
            name: path.basename(childRelativePath),
            relativePath: childRelativePath,
            kind: 'repository',
            source: 'workspace',
            markers,
            viewer: null,
            session: null,
          });
          continue;
        }
        const nestedChildren = await readdir(childRealPath, { withFileTypes: true });
        queue.push(...nestedChildren
          .filter(child => !child.name.startsWith('.') && !ignoredDirectoryNames.has(child.name))
          .filter(child => child.isDirectory() || child.isSymbolicLink())
          .map(child => path.join(childRelativePath, child.name))
          .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
      } catch (error) {
        if (error instanceof ApiError && error.code === 'DIRECTORY_NOT_FOUND') {
          this.logger.warn({ relativePath: childRelativePath }, 'skipped unavailable or out-of-bounds directory entry');
          continue;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') {
          this.logger.warn({ relativePath: childRelativePath, errorCode: code }, 'skipped unreadable directory entry');
          continue;
        }
        throw error;
      }
    }
  }
}
