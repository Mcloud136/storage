import { candidateKeys } from './keys';
import type { FileMetadata, KvRecord } from './keys';

export interface ResolvedRecord {
  record: KvRecord | null;
  kvKey: string;
  candidatesTried: number;
}

/**
 * Resolve a public file id to its KV record, preserving the legacy candidate
 * set: bare key first, then every known storage prefix.
 */
export async function getRecordWithKey(
  kv: KVNamespace,
  id: string,
  options: { maxPrefixes?: number } = {}
): Promise<ResolvedRecord> {
  const candidates = candidateKeys(id, options.maxPrefixes);

  for (let index = 0; index < candidates.length; index += 1) {
    const kvKey = candidates[index];
    const result = await kv.getWithMetadata<FileMetadata>(kvKey);
    if (result?.metadata) {
      return {
        record: {
          value: result.value ?? null,
          metadata: result.metadata,
        },
        kvKey,
        candidatesTried: index + 1,
      };
    }
  }

  return { record: null, kvKey: id, candidatesTried: candidates.length };
}
