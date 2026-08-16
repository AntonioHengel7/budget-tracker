import type { NextFunction, Request, Response } from 'express';
import { verifySession } from './session.js';

/** Augments Express's `Request` with the session-derived, authenticated username. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      username?: string;
    }
  }
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
