const { buildPublicFileId, normalizeStorageType } = require('../storage/common');
const { normalizeFolderPath } = require('../repos/file-repo');

class UploadService {
  constructor({ storageRepo, fileRepo, storageFactory }) {
    this.storageRepo = storageRepo;
    this.fileRepo = fileRepo;
    this.storageFactory = storageFactory;
  }

  resolveStorage({ storageId, storageMode }) {
    const storageConfig = this.storageRepo.resolveStorageSelection({ storageId, storageMode });
    if (!storageConfig) {
      throw new Error('没有可用的存储配置。');
    }
    return storageConfig;
  }

  async uploadFile({
    fileName,
    mimeType,
    fileSize,
    buffer,
    storageId,
    storageMode,
    folderPath,
  }) {
    const storageConfig = this.resolveStorage({ storageId, storageMode });
    const adapter = this.storageFactory.createAdapter(storageConfig);
    const storageType = normalizeStorageType(storageConfig.type);
    const normalizedFolderPath = normalizeFolderPath(folderPath);

    const publicId = buildPublicFileId(storageType, fileName, mimeType);

    let adapterStorageKey = normalizedFolderPath ? `${normalizedFolderPath}/${publicId}` : publicId;
    if (storageType === 'huggingface') {
      adapterStorageKey = normalizedFolderPath
        ? `uploads/${normalizedFolderPath}/${publicId}`
        : `uploads/${publicId}`;
    }

    const uploadResult = await adapter.upload({
      storageKey: adapterStorageKey,
      fileName,
      mimeType,
      fileSize,
      buffer,
    });

    const storageKey = uploadResult.storageKey || adapterStorageKey;

    const fileRecord = this.fileRepo.create({
      id: publicId,
      storageConfigId: storageConfig.id,
      storageType,
      storageKey,
      fileName,
      fileSize,
      mimeType,
      folderPath: normalizedFolderPath,
      extra: uploadResult.metadata || {},
    });

    return {
      file: fileRecord,
      src: `/file/${encodeURIComponent(publicId)}`,
      storage: {
        id: storageConfig.id,
        name: storageConfig.name,
        type: storageType,
      },
    };
  }

  async uploadFromUrl({
    url,
    storageId,
    storageMode,
    folderPath,
    maxBytes = 20 * 1024 * 1024,
  }) {
    const { assertSafeRemoteUrl, validateRedirectLocation, MAX_REDIRECTS } = require('../utils/ssrf-guard');

    let currentUrl = new URL(url);
    if (!['http:', 'https:'].includes(currentUrl.protocol)) {
      const error = new Error('仅支持 HTTP/HTTPS URL。');
      error.code = 'INVALID_URL';
      throw error;
    }

    let response = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const safety = await assertSafeRemoteUrl(currentUrl.href);
      if (!safety.ok) {
        const error = new Error(safety.message || 'Unsafe remote URL.');
        error.code = safety.code;
        throw error;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        response = await fetch(currentUrl.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'K-Vault/2.0 (+https://github.com/katelya77/K-Vault)',
            Accept: '*/*',
          },
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') || '';
        if (!location) throw new Error('远程地址返回了缺少 Location 的重定向。');
        const redirectCheck = validateRedirectLocation(location, currentUrl);
        if (!redirectCheck.ok) throw new Error(redirectCheck.message || 'Unsafe redirect target.');
        currentUrl = redirectCheck.url;
        continue;
      }
      break;
    }

    if (!response) {
      throw new Error('远程地址重定向次数过多。');
    }
    if (!response.ok) {
      throw new Error(`目标 URL 响应异常：${response.status}。`);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`远程文件超过大小限制（${Math.floor(maxBytes / 1024 / 1024)}MB）。`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const reader = response.body?.getReader();
    if (!reader) throw new Error('目标 URL 响应没有正文。');
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          throw new Error(`远程文件超过大小限制（${Math.floor(maxBytes / 1024 / 1024)}MB）。`);
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* noop */ }
      throw error;
    }

    const arrayBuffer = Buffer.concat(chunks, received);
    if (arrayBuffer.byteLength === 0) {
      throw new Error('目标 URL 返回了空文件。');
    }

    let fileName = decodeURIComponent(currentUrl.pathname.split('/').pop() || '').trim();
    if (!fileName) {
      fileName = `url_${Date.now()}`;
    }

    if (!fileName.includes('.')) {
      const ext = String(contentType).split('/')[1]?.split(';')[0] || 'bin';
      fileName = `${fileName}.${ext}`;
    }

    return this.uploadFile({
      fileName,
      mimeType: contentType,
      fileSize: arrayBuffer.byteLength,
      buffer: arrayBuffer,
      storageId,
      storageMode,
      folderPath,
    });
  }

  async getFileResponse(fileId, rangeHeader) {
    const file = this.fileRepo.getById(fileId);
    if (!file) return null;

    const storageConfig = this.storageRepo.getById(file.storage_config_id, true);
    if (!storageConfig) {
      throw new Error('文件引用的存储配置不存在。');
    }

    const adapter = this.storageFactory.createAdapter(storageConfig);
    const response = await adapter.download({
      storageKey: file.storage_key,
      metadata: file.metadata,
      range: rangeHeader,
    });

    if (!response) return null;

    return {
      file,
      response,
    };
  }

  async deleteFile(fileId) {
    const file = this.fileRepo.getById(fileId);
    if (!file) return { deleted: false, reason: 'not-found' };

    const storageConfig = this.storageRepo.getById(file.storage_config_id, true);
    if (storageConfig) {
      const adapter = this.storageFactory.createAdapter(storageConfig);
      try {
        await adapter.delete({ storageKey: file.storage_key, metadata: file.metadata });
      } catch (error) {
        // best-effort cleanup on remote storage
      }
    }

    this.fileRepo.delete(fileId);
    return { deleted: true };
  }
}

module.exports = {
  UploadService,
};
