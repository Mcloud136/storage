import { Hono } from 'hono';
import type { Env } from '../env';
import { requireAdmin } from '../lib/auth';
import { apiError, json } from '../lib/http';
import {
  findStoredFile,
  listAllFileRecords,
  listFolderMarkers,
  normalizeFolderPath,
  updateMetadata,
  type StoredFile,
} from '../lib/file-store';
import { createBackend } from '../backends';
import { StorageError } from '../backends/types';

export const manageRoutes = new Hono<{ Bindings: Env }>();

async function guard(c: { req: { raw: Request }; env: Env }): Promise<Response | null> {
  return requireAdmin(c.req.raw, c.env);
}

function sortFiles(files: StoredFile[], sort: string): StoredFile[] {
  const copy = [...files];
  const byTime = (a: StoredFile, b: StoredFile) =>
    Number(a.metadata.TimeStamp || 0) - Number(b.metadata.TimeStamp || 0);
  const bySize = (a: StoredFile, b: StoredFile) =>
    Number(a.metadata.fileSize || 0) - Number(b.metadata.fileSize || 0);
  const byName = (a: StoredFile, b: StoredFile) =>
    String(a.metadata.fileName || a.kvKey).localeCompare(String(b.metadata.fileName || b.kvKey));

  if (sort === 'sizeAsc') return copy.sort(bySize);
  if (sort === 'sizeDesc') return copy.sort((a, b) => bySize(b, a));
  if (sort === 'timeAsc') return copy.sort(byTime);
  if (sort === 'nameAsc') return copy.sort(byName);
  if (sort === 'nameDesc') return copy.sort((a, b) => byName(b, a));
  return copy.sort((a, b) => byTime(b, a));
}

function folderList(files: StoredFile[], markers: string[], storage: string) {
  const map = new Map<string, { path: string; name: string; fileCount: number }>();
  const add = (path: string) => {
    const normalized = normalizeFolderPath(path);
    if (!normalized) return;
    const segments = normalized.split('/');
    const entry = map.get(normalized) || {
      path: normalized,
      name: segments[segments.length - 1],
      fileCount: 0,
    };
    map.set(normalized, entry);
  };

  for (const marker of markers) add(marker);
  for (const file of files) {
    if (storage !== 'all' && file.storageType !== storage) continue;
    const path = normalizeFolderPath(String(file.metadata.folderPath || ''));
    if (!path) continue;
    add(path);
    const entry = map.get(path);
    if (entry) entry.fileCount += 1;
  }

  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

manageRoutes.get('/api/manage/list', async (c) => {
  const unauthorized = await guard(c);
  if (unauthorized) return unauthorized;

  const url = new URL(c.req.url);
  const storage = String(url.searchParams.get('storage') || 'all').toLowerCase();
  const folderPath = normalizeFolderPath(url.searchParams.get('folderPath') || '');
  const includeFolders = url.searchParams.get('includeFolders') === '1';
  const sort = String(url.searchParams.get('sort') || 'timeDesc');
  const rawLimit = parseInt(url.searchParams.get('limit') || '100', 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 1000);
  const offset = Math.max(parseInt(url.searchParams.get('cursor') || '0', 10) || 0, 0);

  const allFiles = await listAllFileRecords(c.env.img_url);
  let filtered = allFiles;
  if (storage !== 'all') filtered = filtered.filter((file) => file.storageType === storage);
  if (folderPath) {
    filtered = filtered.filter(
      (file) => normalizeFolderPath(String(file.metadata.folderPath || '')) === folderPath
    );
  }

  filtered = sortFiles(filtered, sort);
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + limit < filtered.length ? offset + limit : null;
  const folders = includeFolders
    ? folderList(allFiles, await listFolderMarkers(c.env.img_url), storage)
    : [];

  return json({
    success: true,
    keys: page.map((file) => ({ name: file.kvKey, metadata: file.metadata })),
    cursor: nextOffset == null ? null : String(nextOffset),
    list_complete: nextOffset == null,
    stats: { total: filtered.length },
    folders,
  });
});

manageRoutes.get('/api/manage/folders', async (c) => {
  const unauthorized = await guard(c);
  if (unauthorized) return unauthorized;

  const url = new URL(c.req.url);
  const storage = String(url.searchParams.get('storage') || 'all').toLowerCase();
  const files = await listAllFileRecords(c.env.img_url);
  const markers = await listFolderMarkers(c.env.img_url);
  return json({ success: true, folders: folderList(files, markers, storage) });
});

manageRoutes.post('/api/manage/folders', async (c) => {
  const unauthorized = await guard(c);
  if (unauthorized) return unauthorized;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const path = normalizeFolderPath(String(body.path || ''));
  if (!path) return json({ success: false, error: '目录路径不能为空' }, 400);

  await c.env.img_url.put(`folder:${path}`, '', {
    metadata: { folderMarker: true, folderPath: path, TimeStamp: Date.now() },
  });
  return json({ success: true, path });
});

manageRoutes.put('/api/manage/folders', async (c) => {
  const unauthorized = await guard(c);
  if (unauthorized) return unauthorized;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const source = normalizeFolderPath(String(body.sourcePath || ''));
  const target = normalizeFolderPath(String(body.targetPath || ''));
  if (!source || !target) return json({ success: false, error: '源目录和目标目录不能为空' }, 400);

  const files = await listAllFileRecords(c.env.img_url);
  let moved = 0;
  for (const file of files) {
    const current = normalizeFolderPath(String(file.metadata.folderPath || ''));
    if (current !== source && !current.startsWith(`${source}/`)) continue;
    const next = `${target}${current.slice(source.length)}`;
    await updateMetadata(c.env.img_url, file.kvKey, { ...file.metadata, folderPath: next });
    moved += 1;
  }

  await c.env.img_url.delete(`folder:${source}`);
  await c.env.img_url.put(`folder:${target}`, '', {
    metadata: { folderMarker: true, folderPath: target, TimeStamp: Date.now() },
  });

  return json({ success: true, moved });
});

manageRoutes.delete('/api/manage/folders', async (c) => {
  const unauthorized = await guard(c);
  if (unauthorized) return unauthorized;

  const url = new URL(c.req.url);
  const path = normalizeFolderPath(url.searchParams.get('path') || '');
  if (!path) return json({ success: false, error: '目录路径不能为空' }, 400);

  const files = await listAllFileRecords(c.env.img_url);
  let moved = 0;
  for (const file of files) {
    const current = normalizeFolderPath(String(file.metadata.folderPath || ''));
    if (current !== path && !current.startsWith(`${path}/`)) continue;
    await updateMetadata(c.env.img_url, file.kvKey, { ...file.metadata, folderPath: '' });
    moved += 1;
  }

  await c.env.img_url.delete(`folder:${path}`);
  return json({ success: true, moved });
});

manageRoutes.post('/api/manage/files/move-folder', async (c) => {
  const unauthorized = await guard(c);
  if (unauthorized) return unauthorized;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const target = normalizeFolderPath(String(body.targetFolderPath || ''));
  const candidates: string[] = [];
  if (Array.isArray(body.ids)) {
    candidates.push(...body.ids.map((item) => String(item)));
  }
  if (Array.isArray(body.files)) {
    for (const item of body.files) {
      if (item && typeof item === 'object') {
        const file = item as Record<string, unknown>;
        for (const value of [file.id, file.fileName, file.name, file.key]) {
          if (value) candidates.push(String(value));
        }
      }
    }
  }

  const files = await listAllFileRecords(c.env.img_url);
  const matched = new Set<string>();
  for (const candidate of candidates) {
    const found =
      files.find((file) => file.kvKey === candidate) ||
      files.find((file) => file.metadata.fileName === candidate);
    if (!found) continue;
    matched.add(found.kvKey);
  }

  if (!matched.size) {
    return json({ success: false, error: '没有找到可移动的文件' }, 404);
  }

  for (const key of matched) {
    const file = files.find((item) => item.kvKey === key);
    if (!file) continue;
    await updateMetadata(c.env.img_url, file.kvKey, { ...file.metadata, folderPath: target });
  }

  return json({ success: true, moved: matched.size });
});

async function recordAction(
  c: { env: Env; req: { raw: Request } },
  id: string,
  mutate: (metadata: Record<string, unknown>) => Record<string, unknown>
): Promise<Response> {
  const unauthorized = await requireAdmin(c.req.raw, c.env);
  if (unauthorized) return unauthorized;

  const found = await findStoredFile(c.env, id);
  if (!found) return json({ success: false, error: 'File not found' }, 404);

  const next = mutate({ ...found.metadata });
  await updateMetadata(c.env.img_url, found.kvKey, next);
  return json({ success: true });
}

manageRoutes.post('/api/manage/toggleLike/:id', async (c) =>
  recordAction(c, c.req.param('id'), (metadata) => ({
    ...metadata,
    liked: !metadata.liked,
  }))
);

manageRoutes.post('/api/manage/editName/:id', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const newName = String(body.newName ?? new URL(c.req.url).searchParams.get('newName') ?? '');
  return recordAction(c, c.req.param('id'), (metadata) => ({
    ...metadata,
    fileName: newName || metadata.fileName,
  }));
});

manageRoutes.post('/api/manage/block/:id', async (c) =>
  recordAction(c, c.req.param('id'), (metadata) => ({ ...metadata, ListType: 'Block' }))
);

manageRoutes.post('/api/manage/white/:id', async (c) =>
  recordAction(c, c.req.param('id'), (metadata) => ({ ...metadata, ListType: 'White' }))
);

manageRoutes.post('/api/manage/delete/:id', async (c) => {
  const unauthorized = await requireAdmin(c.req.raw, c.env);
  if (unauthorized) return unauthorized;

  const found = await findStoredFile(c.env, c.req.param('id'));
  if (!found) return json({ success: false, error: 'File not found' }, 404);

  try {
    const backend = createBackend(found.storageType, c.env);
    await backend.remove({
      id: found.kvKey,
      storageType: found.storageType,
      storageKey: found.kvKey,
      metadata: found.metadata,
    });
  } catch (error) {
    if (!(error instanceof StorageError)) {
      return apiError('DELETE_FAILED', error instanceof Error ? error.message : 'Delete failed.', 502);
    }
  }

  await c.env.img_url.delete(found.kvKey);
  return json({ success: true });
});
