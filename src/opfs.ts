export function isOpfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

export function getOpfsUnsupportedMessage(): string {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'Origin Private File System is unavailable because this page is not running in a secure context. Use HTTPS or localhost.';
  }
  return 'Origin Private File System is not available in this browser/runtime (navigator.storage.getDirectory is unsupported).';
}

export async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsAvailable()) {
    throw new Error(getOpfsUnsupportedMessage());
  }
  return navigator.storage.getDirectory();
}
