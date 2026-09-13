import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types.js';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db.js';

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.path?.startsWith('/admin') || req.baseUrl?.startsWith('/api/admin') || req.originalUrl?.startsWith('/api/admin')) {
    return next();
  }
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Bearer token is required.' });

  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub?: string; partner_id?: string; role?: string };
    if (!payload.sub) return res.status(401).json({ error: 'Invalid or expired token.' });

    let partnerId = payload.partner_id || payload.sub;

    // Check if sub is a restaurant_user (staff member)
    const restoUserCheck = await db.query(
      'SELECT restaurant_id, status FROM restaurant_users WHERE id = $1 OR auth_user_id = $1 LIMIT 1',
      [payload.sub]
    );
    if (restoUserCheck.rows[0]) {
      if (restoUserCheck.rows[0].status === 'suspended') {
        return res.status(403).json({
          error: 'Your account has been suspended by BhojMitra Admin. Please contact support at support@bhojmitra.in.',
          code: 'ACCOUNT_SUSPENDED',
        });
      }
      partnerId = restoUserCheck.rows[0].restaurant_id;
    }

    // Verify if partner is active or suspended
    const partnerCheck = await db.query('SELECT id, status FROM partners WHERE id = $1', [partnerId]);
    if (partnerCheck.rows[0]) {
      if (partnerCheck.rows[0].status === 'suspended') {
        return res.status(403).json({
          error: 'Your account has been suspended by BhojMitra Admin. Please contact support at support@bhojmitra.in.',
          code: 'ACCOUNT_SUSPENDED',
        });
      }
      req.userId = partnerCheck.rows[0].id;
      req.tenantId = partnerCheck.rows[0].id;
      return next();
    }

    req.userId = payload.sub;
    req.tenantId = payload.sub;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

export async function requireTenantIsolation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.userId) {
    return res.status(401).json({ error: 'Authentication required for tenant isolation.' });
  }

  try {
    // Verify the authenticated user is a valid partner and not suspended
    const partner = await db.query('SELECT id, status FROM partners WHERE id=$1', [req.userId]);
    if (!partner.rows[0]) {
      return res.status(403).json({
        error: 'Access denied. User profile not found.',
        code: 'INVALID_TENANT',
      });
    }

    if (partner.rows[0].status === 'suspended') {
      return res.status(403).json({
        error: 'Your account has been suspended by BhojMitra Admin. Please contact support at support@bhojmitra.in.',
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    // Set tenant_id (partner_id) on request for use in all operations
    req.tenantId = req.userId;
    return next();
  } catch (error) {
    return res.status(500).json({ error: 'Unable to verify tenant access.' });
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
