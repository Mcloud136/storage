import type { Env } from '../env';
import type { FileMetadata } from '../core/keys';

const MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wma: 'audio/x-ms-wma',
  opus: 'audio/opus',
  oga: 'audio/ogg',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  md: 'text/markdown',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
};

export function getMimeType(fileName = ''): string {
  const extension = String(fileName).split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[extension] || 'application/octet-stream';
}

export function shouldBlock(metadata: FileMetadata = {}): boolean {
  const listType = String(metadata.ListType || '').toLowerCase();
  const label = String(metadata.Label || '').toLowerCase();
  return listType === 'block' || label === 'adult';
}

export function shouldWhitelistDeny(env: Env, metadata: FileMetadata = {}): boolean {
  if (env.WhiteList_Mode !== 'true') return false;
  return String(metadata.ListType || '').toLowerCase() !== 'white';
}

export function blockRedirect(requestUrl: URL, request: Request): Response {
  if (request.headers.get('Referer')) {
    return Response.redirect('https://static-res.pages.dev/teleimage/img-block-compressed.png', 302);
  }
  return Response.redirect(`${requestUrl.origin}/block-img.html`, 302);
}

export function whitelistRedirect(requestUrl: URL): Response {
  return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
}
