import { adminTenantId, type User } from '@logto/schemas';
import { createMockUtils } from '@logto/shared/esm';
import Koa from 'koa';
import request from 'supertest';

import { mockUser } from '#src/__mocks__/index.js';
import RequestError from '#src/errors/RequestError/index.js';
import { MockTenant } from '#src/test-utils/tenant.js';

const { jest } = import.meta;
const { mockEsm, mockEsmWithActual } = createMockUtils(jest);

const resource = 'https://passport.example/avatar';
const config = { resource };
const appToken = { sub: 'm2m-app', clientId: 'm2m-app', scopes: ['avatar:write'] };
const storedUrl = 'https://assets.example/default/starmoe-avatars/abc.png';
const maxBytes = 512 * 1024;
const image = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

const { verifyBearerTokenFromRequest } = await mockEsmWithActual(
  '#src/middleware/koa-auth/index.js',
  () => ({
    verifyBearerTokenFromRequest: jest.fn(async () => appToken),
  })
);

const { storeAvatarImage } = mockEsm('./avatar-store.js', () => ({
  maxAvatarImageBytes: maxBytes,
  storeAvatarImage: jest.fn(async (_tenantId: string, _data: Uint8Array) => storedUrl),
}));

const { createStarmoeRouter, getStarmoeAvatarConfig } = await import('./avatar.js');

const findUserById = jest.fn(async (id: string) => ({ ...mockUser, id }));
const updateUserById = jest.fn(async (id: string, set: Partial<User>) => ({
  ...mockUser,
  ...set,
  id,
}));

const createTenant = () => new MockTenant(undefined, { users: { findUserById, updateUserById } });

const createRequester = () => {
  const router = createStarmoeRouter(createTenant(), config);

  if (!router) {
    throw new Error('The router should be created');
  }

  return request(new Koa().use(router.routes()).use(router.allowedMethods()).callback());
};

const path = '/starmoe/users/foo/avatar';
const upload = (data: Uint8Array | string, contentType = 'image/png') =>
  createRequester().put(path).set('content-type', contentType).send(data);

afterEach(() => {
  jest.clearAllMocks();
});

describe('getStarmoeAvatarConfig', () => {
  it('is off without the resource', () => {
    expect(getStarmoeAvatarConfig({})).toBeUndefined();
    expect(getStarmoeAvatarConfig({ STARMOE_AVATAR_API_RESOURCE: '  ' })).toBeUndefined();
  });

  it('reads the resource', () => {
    expect(getStarmoeAvatarConfig({ STARMOE_AVATAR_API_RESOURCE: ` ${resource} ` })).toEqual({
      resource,
    });
  });
});

describe('createStarmoeRouter', () => {
  it('is not created without configuration or for the admin tenant', () => {
    expect(createStarmoeRouter(createTenant())).toBeUndefined();

    const adminTenant = createTenant();
    // eslint-disable-next-line @silverhand/fp/no-mutation
    adminTenant.id = adminTenantId;
    expect(createStarmoeRouter(adminTenant, config)).toBeUndefined();
  });
});

describe('PUT /starmoe/users/:userId/avatar', () => {
  it("stores the uploaded image and makes it the user's avatar, and nothing else", async () => {
    const response = await upload(image);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'foo', avatar: storedUrl });
    expect(storeAvatarImage).toHaveBeenCalledTimes(1);
    expect(storeAvatarImage).toHaveBeenCalledWith('mock_id', image);
    expect(updateUserById).toHaveBeenCalledTimes(1);
    expect(updateUserById).toHaveBeenCalledWith('foo', { avatar: storedUrl });
    expect(verifyBearerTokenFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      resource
    );
  });

  it('takes the body as it is, whatever the Content-Type says', async () => {
    const response = await upload(image, 'text/html');

    expect(response.status).toBe(200);
    expect(storeAvatarImage).toHaveBeenCalledWith('mock_id', image);
  });

  it('never treats a JSON body as fields to update', async () => {
    const body = JSON.stringify({ avatar: 'https://evil.example/a.png', name: 'x', password: 'p' });
    storeAvatarImage.mockRejectedValueOnce(
      new RequestError({ code: 'guard.mime_type_not_allowed', status: 415 })
    );
    const response = await upload(body, 'application/json');

    expect(response.status).toBe(415);
    expect(storeAvatarImage).toHaveBeenCalledWith('mock_id', Buffer.from(body));
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('answers 413 to a body that is too large, keeping none of it', async () => {
    const justOver = await upload(Buffer.alloc(maxBytes + 1));
    const wellOver = await upload(Buffer.alloc(3 * maxBytes));

    expect(justOver.status).toBe(413);
    expect(wellOver.status).toBe(413);
    expect(storeAvatarImage).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('takes a body of exactly the largest size', async () => {
    const response = await upload(Buffer.alloc(maxBytes, 1));

    expect(response.status).toBe(200);
    expect(storeAvatarImage).toHaveBeenCalledWith('mock_id', Buffer.alloc(maxBytes, 1));
  });

  it.each([415, 413, 501, 500])(
    'leaves the avatar alone when the image cannot be stored (%s)',
    async (status) => {
      storeAvatarImage.mockRejectedValueOnce(
        new RequestError({ code: 'storage.upload_error', status })
      );
      const response = await upload(image);

      expect(response.status).toBe(status);
      expect(updateUserById).not.toHaveBeenCalled();
    }
  );

  it('answers 404 for an unknown user, storing nothing', async () => {
    findUserById.mockRejectedValueOnce(
      new RequestError({ code: 'entity.not_exists', status: 404 })
    );
    const response = await upload(image);

    expect(response.status).toBe(404);
    expect(storeAvatarImage).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('refuses a token without the scope', async () => {
    verifyBearerTokenFromRequest.mockResolvedValueOnce({ ...appToken, scopes: ['all'] });
    const response = await upload(image);

    expect(response.status).toBe(403);
    expect(storeAvatarImage).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("refuses a user's token even with the scope", async () => {
    verifyBearerTokenFromRequest.mockResolvedValueOnce({ ...appToken, sub: 'some-user' });
    const response = await upload(image);

    expect(response.status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('refuses a token the verifier rejects (wrong audience, bad signature, none)', async () => {
    verifyBearerTokenFromRequest.mockRejectedValueOnce(
      new RequestError({ code: 'auth.unauthorized', status: 401 })
    );
    const response = await upload(image);

    expect(response.status).toBe(401);
    expect(storeAvatarImage).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe('DELETE /starmoe/users/:userId/avatar', () => {
  it('clears the avatar, storing nothing', async () => {
    const response = await createRequester().delete(path);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'foo', avatar: null });
    expect(updateUserById).toHaveBeenCalledWith('foo', { avatar: null });
    expect(storeAvatarImage).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown user and 403 without the scope', async () => {
    findUserById.mockRejectedValueOnce(
      new RequestError({ code: 'entity.not_exists', status: 404 })
    );
    const unknown = await createRequester().delete(path);
    verifyBearerTokenFromRequest.mockResolvedValueOnce({ ...appToken, scopes: [] });
    const forbidden = await createRequester().delete(path);

    expect(unknown.status).toBe(404);
    expect(forbidden.status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe('the router', () => {
  it('serves no other method or path', async () => {
    const requester = createRequester();

    const wrongMethod = await requester.patch(path).send(image);
    const otherPath = await requester.get('/starmoe/users/foo');
    const managementPath = await requester.put('/users/foo').send(image);
    const deleteUser = await requester.delete('/starmoe/users/foo');

    expect(wrongMethod.status).toBe(405);
    expect(otherPath.status).toBe(404);
    expect(managementPath.status).toBe(404);
    expect(deleteUser.status).toBe(404);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});
