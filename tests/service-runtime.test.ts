import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error The runtime helper is an intentionally standalone JavaScript lifecycle script.
import { matchesManagementArguments } from '../scripts/service-runtime.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const runtime = {
  configFile: path.join(projectRoot, 'config.json'),
  workspaceRoot: '/workspace/project',
};

describe('service runtime process identity', () => {
  it('recognizes the current management entry point', () => {
    expect(matchesManagementArguments([
      process.execPath,
      path.join(projectRoot, 'dist/codepilot-server.js'),
      '--config', runtime.configFile,
      '--workspace', runtime.workspaceRoot,
    ], runtime)).toBe(true);
  });

  it('recognizes the legacy management entry point during lifecycle upgrades', () => {
    expect(matchesManagementArguments([
      process.execPath,
      path.join(projectRoot, 'dist/server.js'),
      '--config', runtime.configFile,
      '--workspace-root', runtime.workspaceRoot,
    ], runtime)).toBe(true);
  });

  it('rejects legacy processes from another workspace', () => {
    expect(matchesManagementArguments([
      process.execPath,
      path.join(projectRoot, 'dist/server.js'),
      '--config', runtime.configFile,
      '--workspace-root', '/workspace/other',
    ], runtime)).toBe(false);
  });
});
