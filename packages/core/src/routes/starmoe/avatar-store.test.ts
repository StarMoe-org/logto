import { createHash } from 'node:crypto';

import { StorageProvider } from '@logto/schemas';
import { createMockUtils } from '@logto/shared/esm';

import RequestError from '#src/errors/RequestError/index.js';
import SystemContext from '#src/tenants/SystemContext.js';

const { jest } = import.meta;
const { mockEsm } = createMockUtils(jest);

const uploadFile = jest.fn(
  async (_data: Uint8Array, objectKey: string, _options?: Record<string, unknown>) => ({
    url: `https://assets.example/${objectKey}`,
  })
);

mockEsm('#src/utils/storage/index.js', () => ({
  buildStorage: jest.fn(() => ({ uploadFile })),
}));

const { forgetStoredAvatars, maxAvatarImageBytes, sniffAvatarImage, storeAvatarImage } =
  await import('./avatar-store.js');

const png = (fill: number, length = 64) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(length, fill),
  ]);
const webp = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([1, 2, 3, 4]),
  Buffer.from('WEBP'),
  Buffer.alloc(32, 7),
]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 9)]);
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

const expectStatus = async (promise: Promise<unknown>, status: number) => {
  const error: unknown = await promise.then(
    () => {
      throw new Error('Expected a rejection');
    },
    (error: unknown) => error
  );

  expect(error).toBeInstanceOf(RequestError);
  expect(error).toHaveProperty('status', status);
};

beforeEach(() => {
  forgetStoredAvatars();
  jest.clearAllMocks();
  // eslint-disable-next-line @silverhand/fp/no-mutation
  SystemContext.shared.storageProviderConfig = {
    provider: StorageProvider.S3Storage,
    endpoint: 'https://s3.example',
    bucket: 'passport',
    accessKeyId: 'id',
    accessSecretKey: 'secret',
    publicUrl: 'https://assets.example',
  };
});

describe('sniffAvatarImage', () => {
  it('knows PNG, JPEG and WebP by their first bytes', () => {
    expect(sniffAvatarImage(png(1))).toEqual({ contentType: 'image/png', extension: 'png' });
    expect(sniffAvatarImage(jpeg)).toEqual({ contentType: 'image/jpeg', extension: 'jpg' });
    expect(sniffAvatarImage(webp)).toEqual({ contentType: 'image/webp', extension: 'webp' });
  });

  it.each([
    ['HTML', Buffer.from('<!doctype html><html></html>')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
    ['GIF', Buffer.from('GIF89a')],
    ['RIFF that is not WebP', Buffer.from('RIFF\0\0\0\0WAVEfmt ')],
    ['nothing', Buffer.alloc(0)],
  ])('refuses %s', (_name, data) => {
    expect(sniffAvatarImage(data)).toBeUndefined();
  });
});

describe('storeAvatarImage', () => {
  it('stores the image under its hash and answers where it is served', async () => {
    const url = await storeAvatarImage('default', png(1));

    expect(url).toBe(`https://assets.example/default/starmoe-avatars/${sha256(png(1))}.png`);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledWith(
      png(1),
      `default/starmoe-avatars/${sha256(png(1))}.png`,
      { contentType: 'image/png', publicUrl: 'https://assets.example' }
    );
  });

  it('names the type by the bytes', async () => {
    await expect(storeAvatarImage('default', webp)).resolves.toMatch(/\.webp$/);
    await expect(storeAvatarImage('default', jpeg)).resolves.toMatch(/\.jpg$/);
    expect(uploadFile.mock.calls.map((call) => call[2])).toEqual([
      { contentType: 'image/webp', publicUrl: 'https://assets.example' },
      { contentType: 'image/jpeg', publicUrl: 'https://assets.example' },
    ]);
  });

  it('writes an image once, however many users upload it', async () => {
    const urls = await Promise.all(
      Array.from({ length: 20 }, async () => storeAvatarImage('default', png(1)))
    );
    const later = await storeAvatarImage('default', Buffer.from(png(1)));

    expect(new Set([...urls, later]).size).toBe(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('keeps one object per image and per tenant', async () => {
    const first = await storeAvatarImage('default', png(1));
    const otherImage = await storeAvatarImage('default', png(2));
    const otherTenant = await storeAvatarImage('other', png(1));

    expect(otherImage).not.toBe(first);
    expect(otherTenant).toBe(`https://assets.example/other/starmoe-avatars/${sha256(png(1))}.png`);
    expect(uploadFile).toHaveBeenCalledTimes(3);
  });

  it('writes again after a day, in case the object was removed', async () => {
    const start = Date.now();
    const first = await storeAvatarImage('default', png(1), start);
    const withinTheDay = await storeAvatarImage('default', png(1), start + 23 * 60 * 60 * 1000);
    const nextDay = await storeAvatarImage('default', png(1), start + 25 * 60 * 60 * 1000);

    expect([withinTheDay, nextDay]).toEqual([first, first]);
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['HTML', Buffer.from('<html>sign in</html>')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['an empty body', Buffer.alloc(0)],
  ])('stores nothing that is not an image: %s', async (_name, data) => {
    await expectStatus(storeAvatarImage('default', data), 415);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('stores nothing larger than an avatar', async () => {
    await expectStatus(storeAvatarImage('default', png(1, maxAvatarImageBytes)), 413);
    await expect(
      storeAvatarImage('default', png(1, maxAvatarImageBytes - 8))
    ).resolves.toBeTruthy();
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('answers 501 without a storage provider', async () => {
    // eslint-disable-next-line @silverhand/fp/no-mutation
    SystemContext.shared.storageProviderConfig = undefined;

    await expectStatus(storeAvatarImage('default', png(1)), 501);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('does not remember a failure', async () => {
    uploadFile.mockRejectedValueOnce(new Error('bucket down'));

    await expectStatus(storeAvatarImage('default', png(1)), 500);
    await expect(storeAvatarImage('default', png(1))).resolves.toContain(sha256(png(1)));
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });
});
