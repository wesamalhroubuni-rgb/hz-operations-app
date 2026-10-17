import { LOCATION_TIMEOUT_MS, toWorkLogLocation, withTimeout } from './locationLogic';
import {
  MAX_PHOTOS_PER_LOG,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_EDGE_PX,
  photoFileName,
  remainingPhotoSlots,
  resizeFor,
} from './photoSizing';

describe('photo sizing', () => {
  it('scales the long edge down to 1600 px and keeps the aspect ratio', () => {
    expect(resizeFor(4032, 3024)).toEqual({ width: PHOTO_MAX_EDGE_PX });
    expect(resizeFor(3024, 4032)).toEqual({ height: PHOTO_MAX_EDGE_PX });
    expect(resizeFor(2000, 2000)).toEqual({ width: PHOTO_MAX_EDGE_PX });
  });

  it('never enlarges a small photo (it is only re-encoded)', () => {
    expect(resizeFor(1600, 1200)).toBeNull();
    expect(resizeFor(800, 600)).toBeNull();
    expect(resizeFor(0, 0)).toBeNull();
  });

  it('uses the agreed quality and limit', () => {
    expect(PHOTO_JPEG_QUALITY).toBe(0.7);
    expect(MAX_PHOTOS_PER_LOG).toBe(10);
    expect(remainingPhotoSlots(3)).toBe(7);
    expect(remainingPhotoSlots(12)).toBe(0);
  });

  it('names files without personal data', () => {
    expect(photoFileName(new Date('2026-10-16T09:05:07.123Z'), 0)).toBe(
      'photo-20261016T090507Z-1.jpg',
    );
  });
});

describe('location', () => {
  it('turns a position into the log location with its accuracy', () => {
    expect(
      toWorkLogLocation({ coords: { latitude: 41.01, longitude: 28.97, accuracy: 12.5 } }),
    ).toEqual({
      latitude: 41.01,
      longitude: 28.97,
      accuracy: 12.5,
    });
    expect(
      toWorkLogLocation({ coords: { latitude: 41, longitude: 29, accuracy: null } })?.accuracy,
    ).toBeNull();
    expect(
      toWorkLogLocation({ coords: { latitude: 41, longitude: 29, accuracy: -1 } })?.accuracy,
    ).toBeNull();
  });

  it('drops positions the API would refuse', () => {
    expect(toWorkLogLocation(null)).toBeNull();
    expect(toWorkLogLocation({ coords: { latitude: 91, longitude: 0, accuracy: 5 } })).toBeNull();
    expect(
      toWorkLogLocation({ coords: { latitude: Number.NaN, longitude: 0, accuracy: 5 } }),
    ).toBeNull();
  });

  it('gives up after the timeout instead of blocking', async () => {
    jest.useFakeTimers();
    const never = new Promise<string>(() => undefined);
    const result = withTimeout(never, LOCATION_TIMEOUT_MS, 'fallback');
    jest.advanceTimersByTime(LOCATION_TIMEOUT_MS);
    await expect(result).resolves.toBe('fallback');
    jest.useRealTimers();
  });

  it('answers with the value when it comes in time, and the fallback on an error', async () => {
    await expect(withTimeout(Promise.resolve('fix'), 1000, 'fallback')).resolves.toBe('fix');
    await expect(withTimeout(Promise.reject(new Error('off')), 1000, 'fallback')).resolves.toBe(
      'fallback',
    );
  });
});
