export type SessionStatus = 'running';
export type SessionOrigin = 'managed' | 'external';

export interface SessionInfo {
  name: string;
  status: SessionStatus;
  origin: SessionOrigin;
  repositoryId: string | null;
  relativePath: string | null;
  createdAt: string | null;
  command: string | null;
  webUrl: string;
}

export interface CreateSessionRequest {
  repositoryId: string;
  command: 'codex';
}

export type ProjectKind = 'directory' | 'repository';
export type ProjectMarker = 'git' | 'node' | 'python' | 'rust' | 'go' | 'java';
export type ViewerStatus = 'starting' | 'running' | 'stopping' | 'failed';

export interface ViewerInstance {
  id: string;
  repositoryId: string;
  pid: number;
  upstreamUrl: string;
  webUrl: string;
  createdAt: string;
  lastAccessedAt: string;
  status: ViewerStatus;
}

export interface DirectoryEntry {
  id: string;
  name: string;
  relativePath: string;
  kind: ProjectKind;
  markers: ProjectMarker[];
  viewer: {
    id: string;
    status: ViewerStatus;
    webUrl: string;
  } | null;
  session: {
    name: string;
    status: SessionStatus;
    webUrl: string;
  } | null;
}

export interface DirectoryLocation {
  id: string | null;
  name: string;
  relativePath: string;
}

export interface RepositoryListing {
  current: DirectoryLocation;
  breadcrumbs: DirectoryLocation[];
  entries: DirectoryEntry[];
}

export interface RepositoryEntryResponse extends DirectoryEntry {
  openVsCodeUrl: string;
}

export type RepositoryListingResponse = Omit<RepositoryListing, 'entries'> & {
  entries: RepositoryEntryResponse[];
};

export interface ReadinessChecks {
  workspaceRoot: boolean;
  directoryIdSecret: boolean;
  node: boolean;
  zellij: boolean;
  codeViewer: boolean;
}

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  checks: ReadinessChecks;
}

export interface ZellijWebTokenInfo {
  name: string;
  value: string;
}
