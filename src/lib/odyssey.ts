import { Odyssey, type OdysseyEventHandlers } from '@odysseyml/odyssey';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export type StreamState = 'idle' | 'starting' | 'streaming' | 'ended' | 'error';

export class OdysseyService {
  private client: Odyssey;

  constructor(apiKey: string) {
    this.client = new Odyssey({ apiKey });
  }

  connect(handlers?: OdysseyEventHandlers) {
    return this.client.connect(handlers);
  }

  async startStream(options?: { prompt?: string; portrait?: boolean; image?: File | Blob }) {
    return this.client.startStream(options);
  }

  async interact(prompt: string) {
    return this.client.interact({ prompt });
  }

  async endStream() {
    return this.client.endStream();
  }

  async disconnect() {
    return this.client.disconnect();
  }
}

export async function loadImageFile(url: string, name = 'slide-image') {
  const response = await fetch(encodeURI(url));
  if (!response.ok) {
    throw new Error(`Failed to load image: ${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) {
    const sizeMb = (blob.size / (1024 * 1024)).toFixed(2);
    throw new Error(`Image is too large (${sizeMb} MB). Max is 25 MB.`);
  }
  const type = blob.type || 'image/png';
  return new File([blob], name, { type });
}
