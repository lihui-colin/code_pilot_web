import { describe, expect, it } from 'vitest';
import { supportServiceOperation } from '../src/services/lifecycle-policy.js';

describe('lifecycle support-service policy', () => {
  it('restarts only Zellij Web alongside the management application', () => {
    expect(supportServiceOperation('restart')).toBe('ensure-zellij');
  });

  it('keeps full support-service startup for explicit start and foreground run', () => {
    expect(supportServiceOperation('start')).toBe('ensure-support');
    expect(supportServiceOperation('run')).toBe('ensure-support');
  });
});
