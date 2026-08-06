import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReadinessChecks, ReadinessResult } from '../domain/types.js';
import { withoutZellijEnvironment } from './zellij-environment.js';

const execFileAsync = promisify(execFile);

async function versionMatches(file: string, expected: string, env = process.env): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(file, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      shell: false,
      env,
    });
    return stdout.trim() === expected;
  } catch {
    return false;
  }
}

export async function checkToolReadiness(
  directoryIdSecretAvailable: boolean,
  zellijExecutablePath = 'zellij',
  codeViewerExecutablePath = 'code-viewer',
  stateAvailable = true,
): Promise<ReadinessResult> {
  const checks: ReadinessChecks = {
    workspaceRoot: true,
    state: stateAvailable,
    directoryIdSecret: directoryIdSecretAvailable,
    node: process.versions.node.startsWith('26.'),
    zellij: await versionMatches(zellijExecutablePath, 'zellij 0.44.3', withoutZellijEnvironment(process.env)),
    codeViewer: await versionMatches(codeViewerExecutablePath, '0.10.0'),
  };
  return {
    status: Object.values(checks).every(Boolean) ? 'ready' : 'not_ready',
    checks,
  };
}
