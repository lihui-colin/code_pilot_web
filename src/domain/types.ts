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
  openVSCodeUrl: string | null;
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
  current: { id: string; name: string; relativePath: string; gitRepository: boolean };
  parentId: string | null;
  entries: RepositoryFolderEntry[];
}

export interface ReadinessChecks {
  workspaceRoot: boolean;
  state: boolean;
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
  mode: 'yolo' | 'sandbox';
}

export interface CodexChatAppearance {
  fontFamily: string;
  fontSize: number;
}

export interface CodexChatMessageSnapshot {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  contextFiles?: string[];
}

export interface CodexActivitySnapshot {
  id: string;
  assistantMessageId: string;
  kind: 'thinking' | 'command' | 'file-change' | 'tool';
  title: string;
  status: 'running' | 'completed' | 'failed';
  detail?: string;
  files?: Array<{
    path: string;
    kind: string;
  }>;
}

export interface CodexAppServerEventSnapshot {
  id: string;
  sequence: number;
  kind: 'notification' | 'request' | 'response';
  method: string;
  requestId: string | null;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  status: 'received' | 'completed' | 'failed';
  updatedAt: string;
}

export interface CodexConversationSnapshot {
  repositoryId: string;
  conversationId: string | null;
  messages: CodexChatMessageSnapshot[];
  activities?: CodexActivitySnapshot[];
  status: 'idle' | 'running' | 'failed' | 'stopped';
  phase?: 'starting' | 'generating';
  error: string | null;
  updatedAt: string;
}

export type CodexConversationStreamEvent =
  | {
    type: 'conversation.snapshot';
    conversation: CodexConversationSnapshot | null;
  }
  | {
    type: 'turn.started';
    repositoryId: string;
    conversationId: string | null;
    userMessage: CodexChatMessageSnapshot;
    assistantMessage: CodexChatMessageSnapshot;
    phase: 'starting';
    updatedAt: string;
  }
  | {
    type: 'thread.started';
    repositoryId: string;
    conversationId: string;
    phase: 'generating';
    updatedAt: string;
  }
  | {
    type: 'turn.steered';
    repositoryId: string;
    conversationId: string;
    userMessage: CodexChatMessageSnapshot;
    assistantMessage: CodexChatMessageSnapshot;
    phase: 'generating';
    updatedAt: string;
  }
  | {
    type: 'app-server.event';
    repositoryId: string;
    event: CodexAppServerEventSnapshot;
    updatedAt: string;
  }
  | {
    type: 'message.delta';
    repositoryId: string;
    conversationId: string | null;
    messageId: string;
    delta: string;
    phase: 'generating';
    updatedAt: string;
  }
  | {
    type: 'message.completed';
    repositoryId: string;
    conversationId: string | null;
    message: CodexChatMessageSnapshot;
    phase: 'generating';
    updatedAt: string;
  }
  | {
    type: 'activity.updated';
    repositoryId: string;
    conversationId: string | null;
    activity: CodexActivitySnapshot;
    phase: 'generating';
    updatedAt: string;
  }
  | {
    type: 'turn.completed';
    repositoryId: string;
    conversationId: string | null;
    assistantMessageId: string;
    assistantMessage: CodexChatMessageSnapshot | null;
    rollbackMessageIds?: string[];
    status: 'idle' | 'failed' | 'stopped';
    error: string | null;
    updatedAt: string;
  }
  | {
    type: 'conversation.cleared';
    repositoryId: string;
    updatedAt: string;
  };

export interface CodexConversationActivity {
  runningRepositoryIds: string[];
}
