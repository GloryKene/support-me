// How long a blob URL stays alive after the download starts. Safari and
// some Chromium builds read the blob asynchronously, so revoking it in the
// same tick can produce an empty or failed download.
export const DOWNLOAD_REVOKE_DELAY_MS = 1000;

/**
 * Triggers a browser download of a blob, then revokes the object URL once
 * the download has had time to start.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
}
