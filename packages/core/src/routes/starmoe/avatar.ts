/**
 * StarMoe patch: one narrow way for a trusted StarMoe service to set a user's avatar.
 *
 * The Management API has a single permission, `all`. A service that only needs to write avatars
 * would have to hold a credential that can do anything to any user. This router gives it a token
 * that can do one thing instead:
 *
 *   PUT    /api/starmoe/users/:userId/avatar   the image as the request body
 *   DELETE /api/starmoe/users/:userId/avatar   no avatar
 *
 * - The token is a machine-to-machine access token for the API resource named by
 *   `STARMOE_AVATAR_API_RESOURCE`, carrying the scope `avatar:write`. Management API tokens are
 *   for another audience and are refused here; tokens for this resource lack `all` and are
 *   refused by every Management API route.
 * - The caller uploads the image: a PNG, JPEG or WebP of at most 512 KiB, told by its bytes and not
 *   by the `Content-Type`. Logto does not know or ask where it came from. It is kept in the
 *   user-assets storage, shared by everyone with the same image (./avatar-store.ts), and the user's
 *   avatar becomes the URL it is served at.
 * - Without the variable the router is not mounted and the paths answer 404. Without a storage
 *   provider (`storageProvider` in the systems table) uploading answers 501.
 *
 * Users cannot change their avatar themselves while the account center's `avatar` field is not
 * `Edit`; that setting is unrelated to this route.
 */
import { type IncomingMessage } from 'node:http';

import { adminTenantId } from '@logto/schemas';
import { type Optional } from '@silverhand/essentials';
import type { MiddlewareType } from 'koa';
import Router, { type IRouterParamContext } from 'koa-router';
import { object, string } from 'zod';

import { type EnvSet } from '#src/env-set/index.js';
import RequestError from '#src/errors/RequestError/index.js';
import {
  type WithAuthContext,
  verifyBearerTokenFromRequest,
} from '#src/middleware/koa-auth/index.js';
import koaGuard from '#src/middleware/koa-guard.js';
import {
  koaManagementApiHooks,
  type WithHookContext,
} from '#src/middleware/koa-management-api-hooks.js';
import type TenantContext from '#src/tenants/TenantContext.js';
import assertThat from '#src/utils/assert-that.js';

import { maxAvatarImageBytes, storeAvatarImage } from './avatar-store.js';

export const starmoeAvatarScope = 'avatar:write';

export type StarmoeAvatarConfig = {
  /** The API resource indicator the access token must be issued for. */
  resource: string;
};

/** Reads the configuration; `undefined` (the routes stay off) without the resource. */
export const getStarmoeAvatarConfig = (
  env: Record<string, Optional<string>> = process.env
): Optional<StarmoeAvatarConfig> => {
  const resource = env.STARMOE_AVATAR_API_RESOURCE?.trim();

  if (!resource) {
    return;
  }

  return { resource };
};

/**
 * Lets through machine-to-machine tokens issued for `resource` that carry {@link starmoeAvatarScope}.
 * A user's token is refused even with the scope: a user must not reach other users' avatars.
 */
export const koaStarmoeAvatarAuth =
  <StateT, ContextT extends IRouterParamContext, ResponseT>(
    envSet: EnvSet,
    resource: string
  ): MiddlewareType<StateT, WithAuthContext<ContextT>, ResponseT> =>
  async (ctx, next) => {
    const { sub, clientId, scopes } = await verifyBearerTokenFromRequest(
      envSet,
      ctx.request,
      resource
    );

    assertThat(
      sub === clientId && scopes.includes(starmoeAvatarScope),
      new RequestError({ code: 'auth.forbidden', status: 403 })
    );

    ctx.auth = { type: 'app', id: sub, scopes: new Set(scopes) };

    return next();
  };

const tooLarge = () => new RequestError({ code: 'guard.file_size_exceeded', status: 413 });

/** Past this much, the rest of an oversized body is not read and the connection is dropped. */
const maxDrainedBytes = 8 * 1024 * 1024;

/**
 * Reads the request body as it is: nothing is parsed and nothing is written to disk. At most an
 * avatar's worth is kept. An oversized body is read to its end (up to 8 MiB) and discarded, so that
 * the caller gets the 413 instead of a broken connection.
 */
const readImageBody = async (request: IncomingMessage): Promise<Uint8Array> => {
  assertThat(Number(request.headers['content-length'] ?? 0) <= maxDrainedBytes, tooLarge());

  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line @silverhand/fp/no-let
  let size = 0;

  for await (const chunk of request) {
    // No encoding is set on the request, so every chunk is a Buffer.
    assertThat(
      Buffer.isBuffer(chunk),
      new RequestError({ code: 'guard.invalid_input', status: 400, type: 'body' })
    );
    // eslint-disable-next-line @silverhand/fp/no-mutation
    size += chunk.byteLength;
    assertThat(size <= maxDrainedBytes, tooLarge());

    if (size <= maxAvatarImageBytes) {
      // eslint-disable-next-line @silverhand/fp/no-mutating-methods
      chunks.push(chunk);
    }
  }

  assertThat(size <= maxAvatarImageBytes, tooLarge());

  return Buffer.concat(chunks);
};

export type StarmoeRouter = Router<unknown, WithAuthContext & WithHookContext>;

/** The router, or `undefined` when the API is not configured or the tenant is the admin tenant. */
export const createStarmoeRouter = (
  tenant: TenantContext,
  config: Optional<StarmoeAvatarConfig> = getStarmoeAvatarConfig()
): Optional<StarmoeRouter> => {
  if (!config || tenant.id === adminTenantId) {
    return;
  }

  const { findUserById, updateUserById } = tenant.queries.users;
  const router: StarmoeRouter = new Router();
  const guard = {
    params: object({ userId: string().min(1) }),
    response: object({ id: string(), avatar: string().nullable() }),
  };

  router.use(koaStarmoeAvatarAuth(tenant.envSet, config.resource));
  router.use(koaManagementApiHooks(tenant.libraries.hooks));

  router.put(
    '/starmoe/users/:userId/avatar',
    koaGuard({ ...guard, status: [200, 404, 413, 415, 500, 501] }),
    async (ctx, next) => {
      const { userId } = ctx.guard.params;

      // Throws 404 when there is no such user.
      await findUserById(userId);

      const avatar = await storeAvatarImage(tenant.id, await readImageBody(ctx.req));
      const user = await updateUserById(userId, { avatar });

      ctx.appendDataHookContext('User.Data.Updated', { user });
      ctx.body = { id: user.id, avatar: user.avatar };

      return next();
    }
  );

  router.delete(
    '/starmoe/users/:userId/avatar',
    koaGuard({ ...guard, status: [200, 404] }),
    async (ctx, next) => {
      const { userId } = ctx.guard.params;

      // Throws 404 when there is no such user.
      await findUserById(userId);

      const user = await updateUserById(userId, { avatar: null });

      ctx.appendDataHookContext('User.Data.Updated', { user });
      ctx.body = { id: user.id, avatar: user.avatar };

      return next();
    }
  );

  return router;
};
