export type LifecycleCommand = 'start' | 'restart' | 'run';
export type SupportServiceOperation = 'ensure-support' | 'ensure-zellij';

export function supportServiceOperation(command: LifecycleCommand): SupportServiceOperation {
  return command === 'restart' ? 'ensure-zellij' : 'ensure-support';
}
