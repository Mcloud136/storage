import { getFileExtension } from './telegram';

export interface TelegramMedia {
  kind: string;
  fileId: string;
  fileUniqueId: string;
  mimeType: string;
  fileSize: number;
  fileExtension: string;
  fileName: string;
  messageId: number;
}

export function getTelegramFileFromMessage(message: any): TelegramMedia | null {
  if (!message) return null;

  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo.reduce(
      (previous: any, current: any) =>
        (previous?.file_size || 0) > (current?.file_size || 0) ? previous : current
    );
    return {
      kind: 'photo',
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id || '',
      mimeType: 'image/jpeg',
      fileSize: Number(photo.file_size || 0),
      fileExtension: 'jpg',
      fileName: `photo_${message.message_id || Date.now()}.jpg`,
      messageId: Number(message.message_id || 0),
    };
  }

  const candidates = [
    { key: 'document', fallbackName: 'document', fallbackMime: 'application/octet-stream' },
    { key: 'video', fallbackName: 'video', fallbackMime: 'video/mp4' },
    { key: 'audio', fallbackName: 'audio', fallbackMime: 'audio/mpeg' },
    { key: 'voice', fallbackName: 'voice', fallbackMime: 'audio/ogg' },
    { key: 'animation', fallbackName: 'animation', fallbackMime: 'video/mp4' },
    { key: 'video_note', fallbackName: 'video_note', fallbackMime: 'video/mp4' },
    { key: 'sticker', fallbackName: 'sticker', fallbackMime: 'image/webp' },
  ];

  for (const item of candidates) {
    const data = message[item.key];
    if (!data?.file_id) continue;

    const mimeType = data.mime_type || item.fallbackMime;
    const extension = getFileExtension(data.file_name, mimeType, 'bin');
    return {
      kind: item.key,
      fileId: data.file_id,
      fileUniqueId: data.file_unique_id || '',
      mimeType,
      fileSize: Number(data.file_size || 0),
      fileExtension: extension,
      fileName:
        data.file_name || `${item.fallbackName}_${message.message_id || Date.now()}.${extension}`,
      messageId: Number(message.message_id || 0),
    };
  }

  return null;
}
