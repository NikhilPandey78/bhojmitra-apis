import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types.js';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db.js';

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Bearer token is required.' });

  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub?: string };
    if (!payload.sub) return res.status(401).json({ error: 'Invalid or expired token.' });
    req.userId = payload.sub;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

export async function requireCompletedOnboarding(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await db.query('SELECT onboarding_completed FROM partners WHERE id=$1', [req.userId]);
    if (!result.rows[0]?.onboarding_completed) {
      return res.status(403).json({
        error: 'Complete onboarding before accessing restaurant features.',
        code: 'ONBOARDING_REQUIRED',
      });
    }
    return next();
  } catch {
    return res.status(500).json({ error: 'Unable to verify onboarding status.' });
  }
}
