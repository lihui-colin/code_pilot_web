export function withoutZellijEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => name !== 'ZELLIJ' && !name.startsWith('ZELLIJ_')),
  );
}
