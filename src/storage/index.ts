import type { StorageBackend, StorageType } from './types';

export function createBackend(type: StorageType): StorageBackend {
  throw new Error(`Storage backend "${type}" is implemented in M2.`);
}
