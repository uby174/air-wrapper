import type { MiddlewareHandler } from 'hono';
import type { UserPlan, UserRecord } from '../db/users';
import { ensureUserForAuth } from '../db/users';
import { isUserDeleted } from '../db/privacy';
import { verifyJwtToken } from './jwt';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  plan: UserPlan;
}

export interface ApiVariables {
  authUser: AuthenticatedUser;
}

const bearerPrefix = 'Bearer ';

export const authMiddleware: MiddlewareHandler<{ Variables: ApiVariables }> = async (c, next) => {
  const authorizationHeader = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!authorizationHeader || !authorizationHeader.startsWith(bearerPrefix)) {
    return c.json({ error: 'Missing or invalid Authorization header. Expected Bearer token.' }, 401);
  }

  const token = authorizationHeader.slice(bearerPrefix.length).trim();
  const jwtSecret = process.env.AUTH_JWT_SECRET?.trim();

  if (!jwtSecret) {
    return c.json({ error: 'Server JWT auth is not configured. Set AUTH_JWT_SECRET.' }, 500);
  }

  let payload: ReturnType<typeof verifyJwtToken>;
  try {
    payload = verifyJwtToken(token, jwtSecret);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid JWT token' }, 401);
  }

  if (await isUserDeleted(payload.user_id)) {
    return c.json(
      {
        error: 'User has been deleted. This token is no longer valid. Please sign in again.'
      },
      401
    );
  }

  let user: UserRecord;
  try {
    user = await ensureUserForAuth({
      userId: payload.user_id,
      emailHint: payload.email
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? `Failed to resolve authenticated user: ${error.message}` : 'Unknown user error' },
      500
    );
  }

  c.set('authUser', {
    userId: user.id,
    email: user.email,
    plan: user.plan
  });

  await next();
};
