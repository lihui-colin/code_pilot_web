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
export type RepositorySource = 'workspace' | 'manual';
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
  source: RepositorySource;
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
  openVSCodeUrl: string;
}

export type RepositoryListingResponse = Omit<RepositoryListing, 'entries'> & {
  entries: RepositoryEntryResponse[];
};

export interface RepositoryFolderEntry {
  id: string;
  name: string;
  gitRepository: boolean;
}

export interface RepositoryFolderListing {
  current: { id: string; name: string; gitRepository: boolean };
  parentId: string | null;
  entries: RepositoryFolderEntry[];
}

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

export interface CodexChatRequest {
  repositoryId: string;
  conversationId?: string;
  contextFileIds?: string[];
  message: string;
}

export interface RepositoryContextFile {
  id: string;
  relativePath: string;
  size: number;
}

export interface RepositoryContextFileListing {
  files: RepositoryContextFile[];
  truncated: boolean;
}

export interface CodexCliStatus {
  available: boolean;
  version: string | null;
}

export interface CodexChatMessageSnapshot {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  contextFiles?: string[];
}

export interface CodexConversationSnapshot {
  repositoryId: string;
  conversationId: string | null;
  messages: CodexChatMessageSnapshot[];
  status: 'idle' | 'running' | 'failed' | 'stopped';
  error: string | null;
  updatedAt: string;
}

export type CodexChatStreamEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'assistant_delta'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
