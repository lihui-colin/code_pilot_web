import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfiguration, persistZellijWebToken } from './config.js';
import { checkToolReadiness } from './services/tool-readiness.js';
import { CodexChatService, SpawnCodexAppServerAdapter } from './services/codex-chat-service.js';
import { StateStore } from './services/state-store.js';
import { SpawnServiceRestarter } from './services/service-restarter.js';
import { bootstrapZellij } from './services/zellij-bootstrap.js';
import { ExecFileZellijAdapter, parseSessionNames } from './services/zellij-service.js';
import { ZellijTokenService } from './services/zellij-token-service.js';

async function main(): Promise<void> {
  const require = createRequire(import.meta.url);
  const codeViewerPackageFile = require.resolve('@youtyan/code-viewer/package.json');
  const codeViewerExecutablePath = path.join(path.dirname(codeViewerPackageFile), 'dist/code-viewer.js');
  const loaded = await loadConfiguration();
  const zellijBootstrap = await bootstrapZellij(loaded.config);
  const zellijAdapter = new ExecFileZellijAdapter(zellijBootstrap.zellij.executablePath);
  const stateStore = new StateStore(path.join(path.dirname(loaded.config.directoryIdSecretFile), 'state.json'));
  let actualSessionNames: string[] | null = null;
  try {
    actualSessionNames = parseSessionNames(await zellijAdapter.listSessions());
  } catch {
    process.stderr.write('CodePilot Web warning: unable to reconcile managed Sessions during startup\n');
  }
  const managedSessions = await stateStore.initialize(actualSessionNames);
  const zellijTokenService = new ZellijTokenService(
    zellijBootstrap.zellij.executablePath,
    loaded.config.zellijWebTokenDatabaseFile,
    loaded.config.zellijWebToken,
    {
      persist: token => persistZellijWebToken(loaded.configFilePath, token),
      warn: message => process.stderr.write(`CodePilot Web warning: ${message}\n`),
    },
  );
  const tokenInitialization = await zellijTokenService.initialize();
  loaded.config.zellijWebToken = tokenInitialization.token;
  const readiness = await checkToolReadiness(
    loaded.directoryIdSecret !== null,
    zellijBootstrap.zellij.executablePath,
    codeViewerExecutablePath,
  );
  const codexChatService = new CodexChatService(
    new SpawnCodexAppServerAdapter(),
    stateStore.codexConversations(),
    conversations => stateStore.persistCodexConversations(conversations),
  );
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const app = await createApp(loaded.config, {
    readiness,
    directoryIdSecret: loaded.directoryIdSecret,
    zellijAdapter,
    managedSessions,
    persistManagedSessions: sessions => stateStore.persist(sessions),
    manualRepositoryPaths: stateStore.repositoryPaths(),
    persistManualRepositoryPaths: paths => stateStore.persistRepositoryPaths(paths),
    codeViewerExecutablePath,
    codexChatService,
    zellijTokenService,
    serviceRestarter: new SpawnServiceRestarter(
      path.join(projectRoot, 'scripts/restart-service.sh'),
      loaded.config.workspaceRootRealPath,
      loaded.configFilePath,
      path.join(projectRoot, 'data/codepilot-web-restart.log'),
    ),
    staticRoot: path.resolve('dist/web'),
  });

  app.log.info({
    source: zellijBootstrap.zellij.source,
    downloaded: zellijBootstrap.zellij.downloaded,
    certificateCreated: zellijBootstrap.certificateCreated,
    webSharingConfigured: zellijBootstrap.webSharingConfigured,
    tokenCreated: tokenInitialization.created,
  }, 'zellij startup dependencies initialized');

  const close = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'shutting down management service');
    await app.close();
  };
  process.once('SIGINT', () => void close('SIGINT'));
  process.once('SIGTERM', () => void close('SIGTERM'));

  await app.listen({ host: loaded.config.listenHost, port: loaded.config.listenPort });
}

main().catch(error => {
  process.stderr.write(`CodePilot Web failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
