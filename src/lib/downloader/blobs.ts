const blobs = new Map<string, Blob>();

export function setBlob(id: string, blob: Blob) {
  blobs.set(id, blob);
}

export function getBlob(id: string): Blob | undefined {
  return blobs.get(id);
}

export function clearBlobs() {
  blobs.clear();
}

export function blobCount(): number {
  return blobs.size;
}
