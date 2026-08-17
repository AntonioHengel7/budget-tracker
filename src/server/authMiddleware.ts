import type { NextFunction, Request, Response } from 'express';
import { verifySession } from './session.js';

/** Augments Express's `Request` with the session-derived, authenticated username. */
declare global {
  namespace Express {
    interface Request {
      username?: string;
    }
  }
}

/**
 * A `Request` on which `req.username` is guaranteed to be a real, verified
 * string -- never `undefined`, and never reached via an `as string` cast.
 * Only `isAuthenticatedRequest` below narrows a plain `Request` into this
 * type, and it only returns `true` once `authMiddleware` has actually set
 * `req.username` from a verified session.
 */
export interface AuthenticatedRequest extends Request {
  readonly username: string;
}

/** Runtime narrowing check -- the only place a `Request` becomes an `AuthenticatedRequest`. */
export function isAuthenticatedRequest(req: Request): req is AuthenticatedRequest {
  return typeof req.username === 'string';
}

/**
 * Verifies the `session` cookie via `verifySession`. On success, attaches
 * the authenticated username to `req.username` and calls `next()`. On any
 * missing/invalid/expired session, responds 401 and does not call `next()`.
 */
export function createAuthMiddleware(sessionSecret: string) {
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const token = req.cookies?.['session'] as string | undefined;
    if (typeof token !== 'string' || token === '') {
      res.status(401).json({ error: 'authentication required' });
      return;
    }

    const payload = verifySession(token, sessionSecret);
    if (payload === null) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }

    req.username = payload.username;
    next();
  };
}
