import type { AppConfig } from '../src/config.js';
import path from 'node:path';

export function createTestConfig(workspaceRootRealPath: string): AppConfig {
  return {
    listenHost: '0.0.0.0',
    listenPort: 8024,
    publicBaseUrl: 'https://192.0.2.10:8024',
    zellijWebPort: 8021,
    zellijManagedBinaryFile: '/unused/bin/zellij',
    zellijConfigFile: '/unused/config.kdl',
    zellijWebTokenDatabaseFile: '/unused/tokens.db',
    zellijWebCertificateFile: '/unused/certs/cert.pem',
    zellijWebPrivateKeyFile: '/unused/certs/key.pem',
    zellijWebToken: {
      name: 'terminal-web-test',
      value: '123e4567-e89b-42d3-a456-426614174000',
    },
    openVSCodeExecutableFile: '/unused/openvscode-server',
    openVSCodePort: 8023,
    directoryIdSecretFile: path.join(workspaceRootRealPath, '.terminal-web/directory-id.secret'),
    viewerPortRange: { start: 18_000, end: 18_100 },
    viewerIdleTimeoutMinutes: 60,
    viewerMaxInstances: 10,
    projectMarkers: ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml'],
    allowedSessionCommands: ['codex'],
    codexChatAppearance: {
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      fontSize: 16,
    },
    workspaceRootRealPath,
  };
}
