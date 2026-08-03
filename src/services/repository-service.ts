import { createHmac } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { DirectoryEntry, DirectoryLocation, ProjectMarker, RepositoryListing } from '../domain/types.js';
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

export class RepositoryService {
  private readonly repositoryIndex = new Map<string, string>();

  constructor(
    private readonly workspaceRootRealPath: string,
    private readonly directoryIdSecret: Buffer,
    private readonly configuredMarkers: readonly string[],
    private readonly logger: FastifyBaseLogger,
  ) {}

  private idFor(relativePath: string): string {
    return `dir_${createHmac('sha256', this.directoryIdSecret).update(relativePath).digest('base64url')}`;
  }

  private async resolveContained(relativePath: string): Promise<string> {
    const candidate = path.resolve(this.workspaceRootRealPath, relativePath);
    let targetRealPath: string;
    try {
      targetRealPath = await realpath(candidate);
    } catch (error) {
      throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    }
    const boundary = path.relative(this.workspaceRootRealPath, targetRealPath);
    if (boundary === '..' || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
      throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    }
    return targetRealPath;
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
    return withTimeout(this.scanRoot(), 5_000);
  }

  async resolveRepository(repositoryId: string): Promise<{ realPath: string; relativePath: string }> {
    const relativePath = this.repositoryIndex.get(repositoryId);
    if (relativePath === undefined) throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    const realPath = await this.resolveContained(relativePath);
    if (!(await stat(realPath)).isDirectory()) {
      throw new ApiError(404, 'DIRECTORY_NOT_FOUND', 'Directory was not found');
    }
    const markers = await this.detectMarkers(realPath);
    if (!markers.includes('git')) throw new ApiError(422, 'NOT_A_REPOSITORY', 'Directory is not a Git repository');
    return { realPath, relativePath };
  }

  private async scanRoot(): Promise<RepositoryListing> {
    const currentRealPath = await this.resolveContained('');
    const root = this.rootLocation();
    const rootMarkers = await this.detectMarkers(currentRealPath);
    if (rootMarkers.includes('git')) {
      const id = this.idFor('');
      this.repositoryIndex.clear();
      this.repositoryIndex.set(id, '');
      return {
        current: root,
        breadcrumbs: [root],
        entries: [{
          id,
          name: root.name,
          relativePath: '',
          kind: 'repository',
          markers: rootMarkers,
          viewer: null,
          session: null,
        }],
      };
    }

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
    const entries: DirectoryEntry[] = [];
    while (queue.length > 0) {
      const childRelativePath = queue.shift();
      if (childRelativePath === undefined) break;
      scannedDirectories += 1;
      if (scannedDirectories > maxScannedDirectories) {
        throw new ApiError(422, 'DIRECTORY_TOO_LARGE', 'Directory contains too many entries');
      }
      try {
        const childRealPath = await this.resolveContained(childRelativePath);
        if (visitedRealPaths.has(childRealPath)) continue;
        visitedRealPaths.add(childRealPath);
        if (!(await stat(childRealPath)).isDirectory()) continue;
        const markers = await this.detectMarkers(childRealPath);
        if (markers.includes('git')) {
          const id = this.idFor(childRelativePath);
          entries.push({
            id,
            name: path.basename(childRelativePath),
            relativePath: childRelativePath,
            kind: 'repository',
            markers,
            viewer: null,
            session: null,
          });
          continue;
        }

        const nestedChildren = await readdir(childRealPath, { withFileTypes: true });
        const nestedRelativePaths = nestedChildren
          .filter(child => !child.name.startsWith('.') && !ignoredDirectoryNames.has(child.name))
          .filter(child => child.isDirectory() || child.isSymbolicLink())
          .map(child => path.join(childRelativePath, child.name))
          .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
        queue.push(...nestedRelativePaths);
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

    entries.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
    this.repositoryIndex.clear();
    for (const entry of entries) this.repositoryIndex.set(entry.id, entry.relativePath);
    return {
      current: root,
      breadcrumbs: [root],
      entries,
    };
  }
}
