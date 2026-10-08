import type { AttendeeRecord, VideoProvider, VideoProviderImpl } from './types';
import { zoomProvider } from './zoom';

function notImplemented(key: VideoProvider): VideoProviderImpl {
  return {
    key,
    async listAttendees(): Promise<AttendeeRecord[]> {
      throw new Error(`${key} attendance is not implemented yet`);
    },
    async test() {
      return { ok: false, detail: `${key} is not implemented yet` };
    },
  };
}

const REGISTRY: Record<VideoProvider, VideoProviderImpl> = {
  zoom: zoomProvider,
  google_meet: notImplemented('google_meet'),
  webinargeek: notImplemented('webinargeek'),
};

export function getProvider(key: VideoProvider): VideoProviderImpl {
  return REGISTRY[key];
}

export { zoomProvider };
