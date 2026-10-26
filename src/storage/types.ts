import type { FileMetadata } from '../core/keys';

export type StorageType = 'telegram' | 'huggingface' | 'webdav' | 'github';

export interface FileRecord {
  id: string;
  storageType: StorageType | string;
  storageKey: string;
  metadata: FileMetadata;
}

export interface StorageCapabilities {
  range: boolean;
  maxBytes: number;
  streamUp: boolean;
}

export interface PutInput {
  id: string;
  fileName: string;
  contentType: string;
  body: ReadableStream | ArrayBuffer;
  size: number;
  folderPath?: string;
}

export interface PutResult {
  storageKey: string;
  meta: Record<string, unknown>;
}

export interface OpenInput {
  record: FileRecord;
  method: 'GET' | 'HEAD';
  range?: string | null;
}

export interface OpenResult {
  status: number;
  headers: Headers;
  body: ReadableStream | null;
}

export interface StorageBackend {
  readonly type: StorageType;
  readonly caps: StorageCapabilities;
  put(input: PutInput): Promise<PutResult>;
  open(input: OpenInput): Promise<OpenResult>;
  remove(record: FileRecord): Promise<void>;
  check(): Promise<{ connected: boolean; message: string }>;
}

export type StorageErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UPSTREAM';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly upstreamStatus?: number;

  constructor(code: StorageErrorCode, message: string, upstreamStatus?: number) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}
