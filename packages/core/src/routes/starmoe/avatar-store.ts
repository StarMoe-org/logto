/**
 * StarMoe patch: keep an uploaded avatar image in Logto's own storage, once.
 *
 * The caller uploads the image; Logto knows nothing about where it came from. Thousands of users pick
 * the same few avatars, so the image is shared instead of stored per user (the built-in upload stores
 * one object per upload under the user's id):
 * - the object key is the SHA-256 of the image, so the same image is one object however often and by
 *   whomever it is uploaded;
 * - an image this process stored in the last day is not written again, and concurrent uploads of one
 *   image share one write.
 */
import { createHash } from 'node:crypto';

import { type Optional } from '@silverhand/essentials';

import RequestError from '#src/errors/RequestError/index.js';
import SystemContext from '#src/tenants/SystemContext.js';
import assertThat from '#src/utils/assert-that.js';
import { buildStorage } from '#src/utils/storage/index.js';

/** Avatars are small; the largest this API takes. */
export const maxAvatarImageBytes = 512 * 1024;
const rememberFor = 24 * 60 * 60 * 1000;
const maxRemembered = 10_000;

type AvatarImage = { contentType: string; extension: string };

/**
 * The image type by its first bytes. What the caller calls it does not matter: only these are stored,
 * so nothing that a browser would run (SVG, HTML) ever is.
 */
export const sniffAvatarImage = (data: Uint8Array): Optional<AvatarImage> => {
  const startsWith = (bytes: number[], offset = 0) =>
    bytes.every((byte, index) => data[offset + index] === byte);

  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: 'image/png', extension: 'png' };
  }

  if (startsWith([0xff, 0xd8, 0xff])) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }

  // "RIFF" <size> "WEBP"
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
};

type Remembered = { url: string; expiresAt: number };

const remembered = new Map<string, Remembered>();
const inFlight = new Map<string, Promise<string>>();

/** For tests. */
export const forgetStoredAvatars = () => {
  remembered.clear();
  inFlight.clear();
};

/**
 * Stores the image (unless this process did so in the last day) and answers the URL it is served at.
 * Throws 415 for anything but a PNG, JPEG or WebP image, 413 for one that is too large and 501 when no
 * storage provider is configured.
 */
export const storeAvatarImage = async (
  tenantId: string,
  data: Uint8Array,
  now = Date.now()
): Promise<string> => {
  assertThat(
    data.byteLength <= maxAvatarImageBytes,
    new RequestError({ code: 'guard.file_size_exceeded', status: 413 })
  );

  const image = sniffAvatarImage(data);
  assertThat(image, new RequestError({ code: 'guard.mime_type_not_allowed', status: 415 }));

  const { storageProviderConfig } = SystemContext.shared;
  assertThat(
    storageProviderConfig,
    new RequestError({ code: 'storage.not_configured', status: 501 })
  );

  const objectKey = `${tenantId}/starmoe-avatars/${createHash('sha256')
    .update(data)
    .digest('hex')}.${image.extension}`;
  const known = remembered.get(objectKey);

  if (known && known.expiresAt > now) {
    return known.url;
  }

  const running = inFlight.get(objectKey);

  if (running) {
    return running;
  }

  const task = (async () => {
    try {
      // Writing an object that is already there replaces it with the same bytes: no need to ask first.
      const { url } = await buildStorage(storageProviderConfig)
        .uploadFile(Buffer.from(data), objectKey, {
          contentType: image.contentType,
          publicUrl: storageProviderConfig.publicUrl,
        })
        .catch(() => {
          throw new RequestError({ code: 'storage.upload_error', status: 500 });
        });

      if (remembered.size >= maxRemembered) {
        remembered.clear();
      }
      remembered.set(objectKey, { url, expiresAt: now + rememberFor });

      return url;
    } finally {
      inFlight.delete(objectKey);
    }
  })();

  inFlight.set(objectKey, task);

  return task;
};
