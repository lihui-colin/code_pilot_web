import path from 'node:path';
import { createRequire } from 'node:module';
import { createApp } from './app.js';
import { loadConfiguration, persistZellijWebToken } from './config.js';
import { checkToolReadiness } from './services/tool-readiness.js';
import { bootstrapZellij } from './services/zellij-bootstrap.js';
import { ZellijTokenService } from './services/zellij-token-service.js';

async function main(): Promise<void> {
  const require = createRequire(import.meta.url);
  const codeViewerPackageFile = require.resolve('@youtyan/code-viewer/package.json');
  const codeViewerExecutablePath = path.join(path.dirname(codeViewerPackageFile), 'dist/code-viewer.js');
  const loaded = await loadConfiguration();
  const zellijBootstrap = await bootstrapZellij(loaded.config);
  const zellijTokenService = new ZellijTokenService(
    zellijBootstrap.zellij.executablePath,
    loaded.config.zellijWebTokenDatabaseFile,
    loaded.config.zellijWebToken,
    {
      persist: token => persistZellijWebToken(loaded.configFilePath, token),
      warn: message => process.stderr.write(`Terminal Web warning: ${message}\n`),
    },
  );
  const tokenInitialization = await zellijTokenService.initialize();
  loaded.config.zellijWebToken = tokenInitialization.token;
  const readiness = await checkToolReadiness(
    loaded.directoryIdSecret !== null,
    zellijBootstrap.zellij.executablePath,
    codeViewerExecutablePath,
  );
  const app = await createApp(loaded.config, {
    readiness,
    directoryIdSecret: loaded.directoryIdSecret,
    zellijExecutablePath: zellijBootstrap.zellij.executablePath,
    codeViewerExecutablePath,
    zellijTokenService,
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
  process.stderr.write(`Terminal Web failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
