const DEFAULT_UPLOAD_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_UPLOAD_MAX_IMAGE_BYTES = 100 * 1024;
const MAX_UPLOAD_MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export function resolveUploadMaxImageBytes(rawValue: unknown) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_UPLOAD_MAX_IMAGE_BYTES;
  }

  const normalized = Math.trunc(parsed);
  if (normalized < MIN_UPLOAD_MAX_IMAGE_BYTES) {
    return MIN_UPLOAD_MAX_IMAGE_BYTES;
  }
  if (normalized > MAX_UPLOAD_MAX_IMAGE_BYTES) {
    return MAX_UPLOAD_MAX_IMAGE_BYTES;
  }

  return normalized;
}

export { DEFAULT_UPLOAD_MAX_IMAGE_BYTES };
