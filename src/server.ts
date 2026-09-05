import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID, createHmac, randomBytes, createHash } from 'node:crypto';
import Razorpay from 'razorpay';
import { config } from './config.js';
import { db, initDatabase } from './db.js';
import { requireAuth, requireCompletedOnboarding } from './middleware/auth.js';
import type { AuthenticatedRequest } from './types.js';
import { demoRequestSchema, ticketSchema } from './validation.js';
import { referenceId } from './utils.js';

const app = express();

const allowedOrigins = [
  'https://bhojmitra.in',
  'https://myresto.bhojmitra.in',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  config.corsOrigin,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.bhojmitra.in')) {
        return callback(null, true);
      }
      return callback(null, true); // Permissive in dev/fallback with credentials allowed
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
const tokenFor = (id: string) => jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: '7d' });
const first = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0];

const razorpay = new Razorpay({
  key_id: config.razorpayKeyId,
  key_secret: config.razorpayKeySecret,
});

const ONBOARDING_STATUSES = ['pending', 'in_progress', 'completed'] as const;
const ACCESSIBLE_SUBSCRIPTION_STATUSES = new Set(['trial', 'active']);

async function expireSubscriptions(partnerId: string) {
  await db.query(
    `UPDATE subscriptions
     SET status = 'expired', updated_at = NOW()
     WHERE partner_id = $1
       AND status IN ('trial', 'active', 'past_due')
       AND expiry_date IS NOT NULL
       AND expiry_date <= NOW()`,
    [partnerId],
  );
}

function subscriptionSummary(subscription: any) {
  if (!subscription) return null;
  const expiryDate = subscription.expiry_date ? new Date(subscription.expiry_date) : null;
  const daysRemaining = expiryDate
    ? Math.max(0, Math.ceil((expiryDate.getTime() - Date.now()) / 86_400_000))
    : null;
  return {
    id: subscription.id,
    currentPlan: subscription.plan_name || subscription.plan || null,
    subscriptionStatus: subscription.status,
    startDate: subscription.start_date,
    expiryDate: subscription.expiry_date,
    daysRemaining,
    autoRenew: subscription.auto_renew,
    maxUsersPerBranch: subscription.max_users ?? null,
    maxBranches: subscription.max_branches ?? null,
  };
}

function onboardingSummary(partner: any, subscription: any) {
  const status = ONBOARDING_STATUSES.includes(partner?.onboarding_status)
    ? partner.onboarding_status
    : partner?.onboarding_completed ? 'completed' : 'pending';
  return {
    status,
    showCompleteOnboarding: status !== 'completed',
    showMyRestaurant: status === 'completed',
    restaurantAccessAllowed: status === 'completed' && ACCESSIBLE_SUBSCRIPTION_STATUSES.has(subscription?.status),
  };
}

app.get('/health', async (_req, res) => { try { await db.query('SELECT 1'); res.json({ status: 'ok', database: 'postgresql' }); } catch { res.status(503).json({ status: 'error' }); } });
app.post('/api/auth/register', async (req, res) => {
  const { owner_name, restaurant_name, email, phone, password } = req.body;
  if (![owner_name, restaurant_name, email, phone, password].every((value) => typeof value === 'string' && value.trim()) || password.length < 6) {
    return res.status(400).json({ error: 'Valid registration fields are required.' });
  }
  try {
    const id = randomUUID();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const startDate = new Date();
      await client.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [id, email.trim().toLowerCase(), await bcrypt.hash(password, 12)]);
      await client.query(
  `INSERT INTO partners
   (id,owner_name,restaurant_name,email,phone,onboarding_status,onboarding_completed)
   VALUES ($1,$2,$3,$4,$5,$6,FALSE)`,
  [
    id,
    owner_name.trim(),
    restaurant_name.trim(),
    email.trim().toLowerCase(),
    phone.trim(),
    'pending',
  ]
);
      await client.query('COMMIT');
      return res.status(201).json({ token: tokenFor(id), user: { id, email: email.trim().toLowerCase() } });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } catch { return res.status(409).json({ error: 'An account with this email already exists.' }); }
});
app.post('/api/auth/login', async (req, res) => { const user = await first('SELECT id,email,password_hash FROM users WHERE email=$1', [String(req.body.email || '').trim().toLowerCase()]); if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) return res.status(401).json({ error: 'Invalid email or password.' }); return res.json({ token: tokenFor(user.id), user: { id: user.id, email: user.email } }); });
app.post('/api/demo-requests', async (req, res) => { const parsed = demoRequestSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid demo request.' }); const ref = referenceId('DMO'); const d = parsed.data; const request = await first('INSERT INTO demo_requests (id,name,restaurant_name,email,phone,city,number_of_branches,preferred_date,preferred_time,message,reference_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [randomUUID(), d.name,d.restaurant_name,d.email,d.phone,d.city,d.number_of_branches,d.preferred_date,d.preferred_time,d.message,ref]); return res.status(201).json({ request, reference_id: ref }); });
app.post('/api/contact-queries', async (req, res) => { const { name,email,phone,subject,message } = req.body; if (![name,email,phone,subject,message].every((v) => typeof v === 'string' && v.trim())) return res.status(400).json({ error: 'All contact fields are required.' }); const query = await first('INSERT INTO contact_queries (id,name,email,phone,subject,message,reference_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [randomUUID(),name,email,phone,subject,message,referenceId('QRY')]); return res.status(201).json({ query }); });

// ============================================================
// SINGLE SIGN-ON (SSO) PUBLIC ENDPOINTS
// ============================================================

app.post('/api/auth/sso/exchange', async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code || !/^[a-f0-9]{64}$/i.test(code)) {
    return res.status(400).json({ error: 'Valid SSO authorization code is required.' });
  }

  const codeHash = createHash('sha256').update(code).digest('hex');
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const ssoRow = (
      await client.query(
        `SELECT sso.*, p.owner_name, p.restaurant_name, p.email, p.phone, p.status AS partner_status,
                p.restaurant_type, p.city, p.business_name, p.gst_number, p.business_type, p.number_of_branches, p.onboarding_completed
         FROM sso_authorization_codes sso
         JOIN partners p ON p.id = sso.partner_id
         WHERE sso.code_hash = $1
           AND sso.target_app = 'myresto'
           AND sso.used_at IS NULL
           AND sso.expires_at > NOW()
         FOR UPDATE OF sso`,
        [codeHash]
      )
    ).rows[0];

    if (!ssoRow) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'SSO authorization code is invalid or has expired.' });
    }

    await client.query('UPDATE sso_authorization_codes SET used_at = NOW() WHERE id = $1', [ssoRow.id]);
    await client.query('COMMIT');

    await expireSubscriptions(ssoRow.partner_id);

    const sub = (
      await db.query(
        `SELECT s.*, p.name AS plan_name, p.price, p.billing_cycle AS plan_billing_cycle, p.max_users, p.max_branches
         FROM subscriptions s
         LEFT JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.partner_id = $1
         ORDER BY CASE
           WHEN s.status = 'active' THEN 1
           WHEN s.status = 'trial' THEN 2
           ELSE 3
         END,
         s.updated_at DESC NULLS LAST,
         s.created_at DESC
         LIMIT 1`,
        [ssoRow.partner_id]
      )
    ).rows[0];

    const token = jwt.sign(
      {
        sub: ssoRow.partner_id,
        partner_id: ssoRow.partner_id,
        email: ssoRow.email,
        restaurant_name: ssoRow.restaurant_name,
        owner_name: ssoRow.owner_name,
        role: 'owner',
        app: 'myresto',
        type: 'sso_session',
      },
      config.jwtSecret,
      { expiresIn: '7d' }
    );

    const subscriptionPlan = sub ? (sub.plan_name || sub.plan || 'basic').toLowerCase() : null;
    const defaultBranches = subscriptionPlan === 'pro' ? 9999 : subscriptionPlan === 'basic' ? 5 : subscriptionPlan === 'starter' ? 3 : 2;
    const defaultUsers = subscriptionPlan === 'pro' ? 9999 : subscriptionPlan === 'basic' ? 5 : subscriptionPlan === 'starter' ? 3 : 2;

    return res.json({
      success: true,
      token,
      user: {
        id: ssoRow.partner_id,
        email: ssoRow.email,
        app_metadata: { provider: 'sso' },
        user_metadata: { full_name: ssoRow.owner_name, restaurant_name: ssoRow.restaurant_name },
        aud: 'authenticated',
      },
      restaurant: {
        id: ssoRow.partner_id,
        name: ssoRow.restaurant_name,
        legal_name: ssoRow.business_name || ssoRow.restaurant_name,
        email: ssoRow.email,
        phone: ssoRow.phone || null,
        address: ssoRow.city || '',
        city: ssoRow.city || '',
        state: '',
        postal_code: '',
        country: 'India',
        currency: 'INR',
        logo_url: null,
        status: 'active',
        created_at: ssoRow.created_at,
        updated_at: ssoRow.created_at,
      },
      restaurantUser: {
        id: ssoRow.partner_id,
        restaurant_id: ssoRow.partner_id,
        auth_user_id: ssoRow.partner_id,
        branch_id: null,
        full_name: ssoRow.owner_name,
        email: ssoRow.email,
        phone: ssoRow.phone || null,
        role: 'owner',
        status: 'active',
        created_at: ssoRow.created_at,
      },
      subscription: sub
        ? {
            id: sub.id,
            restaurant_id: ssoRow.partner_id,
            plan: subscriptionPlan,
            status: sub.status || 'active',
            start_date: sub.start_date ? new Date(sub.start_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
            expiry_date: sub.expiry_date ? new Date(sub.expiry_date).toISOString().slice(0, 10) : null,
            billing_cycle: sub.billing_cycle || sub.plan_billing_cycle || 'monthly',
            amount: Number(sub.price ?? sub.amount ?? 0),
            currency: 'INR',
            auto_renewal: Boolean(sub.auto_renew),
            max_branches: sub.max_branches ?? defaultBranches,
            max_users: sub.max_users ?? defaultUsers,
            created_at: sub.created_at,
            updated_at: sub.updated_at || sub.created_at,
          }
        : null,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

async function handleProfileRequest(req: express.Request, res: express.Response) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Bearer token is required.' });

  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub?: string; app?: string };
    if (!payload.sub) {
      return res.status(401).json({ error: 'Invalid session token.' });
    }

    await expireSubscriptions(payload.sub);

    const partner = await first('SELECT * FROM partners WHERE id=$1', [payload.sub]);
    if (!partner) return res.status(404).json({ error: 'Partner profile not found.' });

    const sub = await first(
      `SELECT s.*, sp.name AS plan_name, sp.price, sp.billing_cycle AS plan_billing_cycle, sp.max_users, sp.max_branches
       FROM subscriptions s
       LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.partner_id=$1
       ORDER BY CASE
         WHEN s.status = 'active' THEN 1
         WHEN s.status = 'trial' THEN 2
         ELSE 3
       END,
       s.updated_at DESC NULLS LAST,
       s.created_at DESC
       LIMIT 1`,
      [payload.sub]
    );

    const subscriptionPlan = sub ? (sub.plan_name || sub.plan || 'basic').toLowerCase() : null;
    const defaultBranches = subscriptionPlan === 'pro' ? 9999 : subscriptionPlan === 'basic' ? 5 : subscriptionPlan === 'starter' ? 3 : 2;
    const defaultUsers = subscriptionPlan === 'pro' ? 9999 : subscriptionPlan === 'basic' ? 5 : subscriptionPlan === 'starter' ? 3 : 2;

    const subscriptionObj = sub
      ? {
          id: sub.id,
          restaurant_id: partner.id,
          plan: subscriptionPlan,
          status: sub.status || 'active',
          start_date: sub.start_date ? new Date(sub.start_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
          expiry_date: sub.expiry_date ? new Date(sub.expiry_date).toISOString().slice(0, 10) : null,
          billing_cycle: sub.billing_cycle || sub.plan_billing_cycle || 'monthly',
          amount: Number(sub.price ?? sub.amount ?? 0),
          currency: 'INR',
          auto_renewal: Boolean(sub.auto_renew),
          max_branches: sub.max_branches ?? defaultBranches,
          max_users: sub.max_users ?? defaultUsers,
          created_at: sub.created_at,
          updated_at: sub.updated_at || sub.created_at,
        }
      : null;

    return res.json({
      success: true,
      user: {
        id: partner.id,
        email: partner.email,
        app_metadata: { provider: 'sso' },
        user_metadata: { full_name: partner.owner_name, restaurant_name: partner.restaurant_name },
        aud: 'authenticated',
      },
      restaurant: {
        id: partner.id,
        name: partner.restaurant_name,
        legal_name: partner.business_name || partner.restaurant_name,
        email: partner.email,
        phone: partner.phone || null,
        city: partner.city || '',
        currency: 'INR',
        status: 'active',
      },
      restaurantUser: {
        id: partner.id,
        restaurant_id: partner.id,
        auth_user_id: partner.id,
        full_name: partner.owner_name,
        email: partner.email,
        phone: partner.phone || null,
        role: 'owner',
        status: 'active',
      },
      subscription: subscriptionObj,
    });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session token.' });
  }
}

app.get('/api/auth/sso/me', handleProfileRequest);
app.get('/api/auth/me', handleProfileRequest);
app.get('/auth/me', handleProfileRequest);

app.use('/api', requireAuth);

app.post('/api/auth/my-resto-sso', async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized.' });
  const partner = await first('SELECT * FROM partners WHERE id=$1', [req.userId]);
  if (!partner) return res.status(404).json({ error: 'Partner profile not found.' });

  await expireSubscriptions(req.userId);
  const subscription = await first(
    `SELECT s.*, p.name AS plan_name, p.max_users, p.max_branches
     FROM subscriptions s
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.partner_id = $1
     ORDER BY s.created_at DESC
     LIMIT 1`,
    [req.userId]
  );

  const subStatus = (subscription?.status || partner?.status || 'trial').toLowerCase();
  if (subStatus === 'expired' || subStatus === 'cancelled') {
    return res.status(403).json({
      error: 'Your subscription is expired or inactive. Please renew to access your restaurant.',
      code: 'SUBSCRIPTION_INACTIVE',
    });
  }

  const isOnboarded = Boolean(partner.onboarding_completed || partner.onboarding_status === 'completed');
  if (!isOnboarded) {
    return res.status(403).json({
      error: 'Please complete restaurant onboarding before accessing My Restaurant.',
      code: 'ONBOARDING_REQUIRED',
    });
  }

  const rawCode = randomBytes(32).toString('hex');
  const codeHash = createHash('sha256').update(rawCode).digest('hex');
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds TTL

  await db.query(
    `INSERT INTO sso_authorization_codes (id, code_hash, partner_id, user_id, target_app, expires_at)
     VALUES ($1, $2, $3, $4, 'myresto', $5)`,
    [id, codeHash, req.userId, req.userId, expiresAt]
  );

  const baseRestoUrl = (process.env.MY_RESTO_URL || config.myRestoUrl || 'http://localhost:5173/login').replace(/\/$/, '');
  const targetPath = baseRestoUrl.includes('/login') || baseRestoUrl.includes('/sso/callback')
    ? baseRestoUrl
    : `${baseRestoUrl}/sso/callback`;
  const delimiter = targetPath.includes('?') ? '&' : '?';
  const ssoUrl = `${targetPath}${delimiter}code=${rawCode}`;
  return res.json({
    success: true,
    sso_url: ssoUrl,
    code: rawCode,
    expires_in: 60,
  });
});

const subscriptionSelect = `
  SELECT s.id, s.partner_id AS user_id, s.start_date, s.expiry_date, s.auto_renew, s.status,
    s.plan, s.amount, s.billing_cycle,
    p.id AS plan_id, p.name AS plan_name, p.price, p.billing_cycle AS plan_billing_cycle, p.max_users, p.max_branches, p.features
  FROM subscriptions s
  LEFT JOIN subscription_plans p ON p.id = s.plan_id
  WHERE s.partner_id = $1
  ORDER BY CASE
    WHEN s.status = 'active' THEN 1
    WHEN s.status = 'trial' THEN 2
    ELSE 3
  END,
  s.updated_at DESC NULLS LAST,
  s.created_at DESC
  LIMIT 1`;

const subscriptionResponse = (subscription: any) => {
  const daysRemaining = subscription.expiry_date
    ? Math.max(0, Math.ceil((new Date(subscription.expiry_date).getTime() - Date.now()) / 86_400_000))
    : 0;
  const planName = (subscription.plan_name || subscription.plan || 'basic').toLowerCase();
  return {
    id: subscription.id,
    plan: planName,
    price: Number(subscription.price ?? subscription.amount ?? 0),
    billingCycle: subscription.billing_cycle || subscription.plan_billing_cycle || 'monthly',
    startDate: subscription.start_date,
    expiryDate: subscription.expiry_date,
    daysRemaining,
    autoRenew: Boolean(subscription.auto_renew),
    status: subscription.status || 'active',
    maxUsers: subscription.max_users,
    maxBranches: subscription.max_branches,
    features: subscription.features,
  };
};

app.get('/api/subscriptions/plans', async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    const plans = await db.query(`
      SELECT
        id,
        name,
        price,
        billing_cycle,
        max_users,
        max_branches,
        trial_days,
        features,
        is_active
      FROM subscription_plans
      WHERE is_active = TRUE
      ORDER BY price ASC
    `);

    const trialHistory = await first(
      `SELECT EXISTS (
         SELECT 1
         FROM subscriptions s
         JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.partner_id = $1
           AND LOWER(p.name) = 'free trial'
       ) AS trial_used`,
      [req.userId],
    );

    const partner = await first(
      `SELECT free_trial_used_at
       FROM partners
       WHERE id = $1`,
      [req.userId],
    );

    const trialUsed =
      Boolean(trialHistory?.trial_used) ||
      Boolean(partner?.free_trial_used_at);

    return res.json({
      success: true,
      plans: plans.rows,
      freeTrial: {
        available: !trialUsed,
        used: trialUsed,
        durationDays: 14,
      },
    });
  } catch (error) {
    console.error('GET /api/subscriptions/plans error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch subscription plans',
    });
  }
});

app.get('/api/subscriptions/current', async (req: AuthenticatedRequest, res) => {
  try {
    const subscription = await first(subscriptionSelect, [req.userId]);
    if (!subscription) return res.status(404).json({ success: false, message: 'No active subscription found' });
    res.json({ success: true, subscription: subscriptionResponse(subscription) });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch current subscription' });
  }
});

app.post('/api/subscriptions', async (_req: AuthenticatedRequest, res) => {
  return res.status(403).json({
    success: false,
    message: 'Subscriptions must be created through the payment flow.',
  });
});

async function changePlan(req: AuthenticatedRequest, res: express.Response, direction: 'upgrade' | 'downgrade') {
  try {
    const planId = Number(req.body.planId);
    if (!Number.isInteger(planId)) return res.status(400).json({ success: false, message: 'planId is required' });
    const current = await first(`SELECT s.id, p.price AS current_price FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.partner_id=$1 AND s.status='active' ORDER BY s.created_at DESC LIMIT 1`, [req.userId]);
    const newPlan = await first('SELECT * FROM subscription_plans WHERE id=$1 AND is_active=TRUE', [planId]);
    if (!current || !newPlan) return res.status(404).json({ success: false, message: 'Active subscription or plan not found' });
    const valid = direction === 'upgrade' ? Number(newPlan.price) > Number(current.current_price) : Number(newPlan.price) < Number(current.current_price);
    if (!valid) return res.status(400).json({ success: false, message: `Selected plan is not an ${direction}` });
    await db.query('UPDATE subscriptions SET plan_id=$1,plan=$2,billing_cycle=$3,amount=$4,updated_at=NOW() WHERE id=$5', [newPlan.id, String(newPlan.name).toLowerCase(), newPlan.billing_cycle, newPlan.price, current.id]);
    res.json({ success: true, message: `Subscription ${direction}d to ${newPlan.name}` });
  } catch {
    res.status(500).json({ success: false, message: `Failed to ${direction} subscription` });
  }
}

app.patch('/api/subscriptions/upgrade', (req: AuthenticatedRequest, res) => changePlan(req, res, 'upgrade'));
app.patch('/api/subscriptions/downgrade', (req: AuthenticatedRequest, res) => changePlan(req, res, 'downgrade'));

app.patch('/api/subscriptions/renew', async (req: AuthenticatedRequest, res) => {
  try {
    const subscription = await first("SELECT id,expiry_date FROM subscriptions WHERE partner_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1", [req.userId]);
    if (!subscription) return res.status(404).json({ success: false, message: 'Subscription not found' });
    const expiryDate = new Date(subscription.expiry_date && new Date(subscription.expiry_date) > new Date() ? subscription.expiry_date : new Date());
    expiryDate.setMonth(expiryDate.getMonth() + 1);
    await db.query('UPDATE subscriptions SET expiry_date=$1,status=$2,updated_at=NOW() WHERE id=$3', [expiryDate, 'active', subscription.id]);
    res.json({ success: true, message: 'Subscription renewed successfully', expiryDate });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to renew subscription' });
  }
});

app.patch('/api/subscriptions/cancel', async (req: AuthenticatedRequest, res) => {
  try {
    const subscription = await first("UPDATE subscriptions SET auto_renew=FALSE,updated_at=NOW() WHERE partner_id=$1 AND status='active' RETURNING *", [req.userId]);
    if (!subscription) return res.status(404).json({ success: false, message: 'Active subscription not found' });
    res.json({ success: true, message: 'Subscription cancelled. It will remain active until the expiry date.', subscription });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to cancel subscription' });
  }
});

app.patch('/api/subscriptions/auto-renew', async (req: AuthenticatedRequest, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, message: 'enabled must be true or false' });
    const subscription = await first("UPDATE subscriptions SET auto_renew=$1,updated_at=NOW() WHERE partner_id=$2 AND status='active' RETURNING *", [enabled, req.userId]);
    if (!subscription) return res.status(404).json({ success: false, message: 'Active subscription not found' });
    res.json({ success: true, message: enabled ? 'Auto renewal enabled' : 'Auto renewal disabled', subscription });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to update auto renewal' });
  }
});

app.get('/api/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const partner = await first(
      'SELECT * FROM partners WHERE id=$1',
      [req.userId]
    );

    const subscription = await first(
      'SELECT * FROM subscriptions WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 1',
      [req.userId]
    );

    if (req.userId) await expireSubscriptions(req.userId);

    const latestSubscription = await first(
      `SELECT s.*, p.name AS plan_name, p.max_users, p.max_branches, p.features
       FROM subscriptions s
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.partner_id=$1
       ORDER BY CASE
         WHEN s.status = 'active' THEN 1
         WHEN s.status = 'trial' THEN 2
         ELSE 3
       END,
       s.updated_at DESC NULLS LAST,
       s.created_at DESC
       LIMIT 1`,
      [req.userId]
    );

    const onboarding = onboardingSummary(partner, latestSubscription);
    const subscriptionInfo = subscriptionSummary(latestSubscription);

    return res.json({
      partner,
      subscription: latestSubscription,
      onboarding,
      subscriptionInfo,
      access: {
        showCompleteOnboarding: onboarding.showCompleteOnboarding,
        showMyRestaurant: onboarding.showMyRestaurant,
        restaurantAccessAllowed: onboarding.restaurantAccessAllowed,
      },
    });
  } catch (error) {
    console.error('GET /api/me error:', error);
    return res.status(500).json({
      error: 'Failed to fetch user profile.',
    });
  }
});


app.post('/api/payments/create-order', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const userId: string = req.userId;
    const planName = String(req.body?.plan || '').trim().toLowerCase();
    const billingCycle = String(req.body?.billing_cycle || 'monthly').trim().toLowerCase();
    const action = String(req.body?.action || 'upgrade').trim().toLowerCase();

    if (!['initial', 'renew', 'upgrade', 'downgrade'].includes(action)) {
      return res.status(400).json({ error: 'Invalid payment action.' });
    }

    if (!planName) {
      return res.status(400).json({ error: 'Plan is required.' });
    }

    if (!['monthly', 'yearly'].includes(billingCycle)) {
      return res.status(400).json({ error: 'Invalid billing cycle.' });
    }

    const plan = await first(
      `SELECT id, name, price, billing_cycle, is_active
       FROM subscription_plans
       WHERE LOWER(name) = $1
         AND is_active = TRUE
       LIMIT 1`,
      [planName],
    );

    if (!plan) {
      return res.status(404).json({ error: 'Selected plan is not available.' });
    }

    if (String(plan.name).toLowerCase() === 'free trial') {
      return res.status(400).json({
        error: 'Free Trial does not require payment.',
      });
    }

    if (billingCycle !== String(plan.billing_cycle).toLowerCase()) {
      return res.status(400).json({
        error: 'Invalid billing cycle for selected plan.',
      });
    }

    const amount = Number(plan.price);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid plan amount.',
      });
    }

    const existingSubscription = await first(
      `SELECT id, plan_id, plan, billing_cycle, status, amount,
              expiry_date, payment_action,
              pending_plan_id, pending_plan,
              pending_billing_cycle, pending_amount
       FROM subscriptions
       WHERE partner_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );

    let order: any;

    /*
     * INITIAL PAYMENT
     *
     * First-time paid onboarding can create the subscription
     * record in pending state. The selected paid plan is only
     * activated after successful Razorpay verification.
     */
    if (action === 'initial') {
      /*
       * INITIAL payment is only allowed when there is no active
       * paid subscription. Never convert an active subscription
       * into pending because of an initial-payment request.
       */
      if (
        existingSubscription &&
        ['active', 'trial'].includes(
          String(existingSubscription.status).toLowerCase(),
        )
      ) {
        return res.status(400).json({
          error: 'An existing subscription is already active.',
        });
      }

      order = await new Promise<any>((resolve, reject) => {
        razorpay.orders.create(
          {
            amount: Math.round(amount * 100),
            currency: 'INR',
            receipt: `sub_${userId}_${Date.now()}`,
            notes: {
              partner_id: userId,
              plan_id: String(plan.id),
              plan_name: String(plan.name),
              billing_cycle: billingCycle,
            },
          },
          (error: any, createdOrder: any) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(createdOrder);
          },
        );
      });

      if (existingSubscription) {
        await db.query(
          `UPDATE subscriptions
           SET pending_plan_id = $1,
               pending_plan = $2,
               pending_billing_cycle = $3,
               pending_amount = $4,
               status = 'pending',
               razorpay_order_id = $5,
               razorpay_payment_id = NULL,
               razorpay_signature = NULL,
               payment_action = $6,
               updated_at = NOW()
           WHERE id = $7
             AND partner_id = $8`,
          [
            plan.id,
            String(plan.name).toLowerCase(),
            billingCycle,
            amount,
            order.id,
            action,
            existingSubscription.id,
            userId,
          ],
        );
      } else {
        await db.query(
          `INSERT INTO subscriptions
           (id, partner_id, plan_id, plan, billing_cycle, status,
            start_date, expiry_date, auto_renew, amount,
            razorpay_order_id, razorpay_payment_id,
            razorpay_signature, payment_action,
            pending_plan_id, pending_plan,
            pending_billing_cycle, pending_amount)
           VALUES
           ($1, $2, NULL, NULL, NULL, 'pending',
            NULL, NULL, TRUE, 0,
            $3, NULL, NULL, $4,
            $5, $6, $7, $8)`,
          [
            randomUUID(),
            userId,
            order.id,
            action,
            plan.id,
            String(plan.name).toLowerCase(),
            billingCycle,
            amount,
          ],
        );
      }
    } else {
      /*
       * RENEW / UPGRADE / DOWNGRADE
       * Existing active subscription is never changed before
       * successful payment verification.
       */
      if (!existingSubscription) {
        return res.status(404).json({
          error: 'Subscription record not found.',
        });
      }

      if (
        (action === 'upgrade' || action === 'downgrade') &&
        existingSubscription.status !== 'active'
      ) {
        return res.status(400).json({
          error: 'An active subscription is required for this action.',
        });
      }

      if (
        action === 'renew' &&
        !['active', 'expired'].includes(
          String(existingSubscription.status).toLowerCase(),
        )
      ) {
        return res.status(400).json({
          error: 'Subscription is not eligible for renewal.',
        });
      }

      if (
        action === 'upgrade' &&
        Number(plan.price) <= Number(existingSubscription.amount)
      ) {
        return res.status(400).json({
          error: 'Selected plan is not an upgrade.',
        });
      }

      if (
        action === 'downgrade' &&
        Number(plan.price) >= Number(existingSubscription.amount)
      ) {
        return res.status(400).json({
          error: 'Selected plan is not a downgrade.',
        });
      }

      if (
        action === 'renew' &&
        String(plan.name).toLowerCase() !==
          String(existingSubscription.plan).toLowerCase()
      ) {
        return res.status(400).json({
          error: 'Renewal must use the current plan.',
        });
      }

      order = await new Promise<any>((resolve, reject) => {
        razorpay.orders.create(
          {
            amount: Math.round(amount * 100),
            currency: 'INR',
            receipt: `sub_${userId}_${Date.now()}`,
            notes: {
              partner_id: userId,
              plan_id: String(plan.id),
              plan_name: String(plan.name),
              billing_cycle: billingCycle,
            },
          },
          (error: any, createdOrder: any) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(createdOrder);
          },
        );
      });

      await db.query(
        `UPDATE subscriptions
         SET razorpay_order_id = $1,
             razorpay_payment_id = NULL,
             razorpay_signature = NULL,
             payment_action = $2,
             pending_plan_id = $3,
             pending_plan = $4,
             pending_billing_cycle = $5,
             pending_amount = $6,
             updated_at = NOW()
         WHERE id = $7
           AND partner_id = $8
           AND status = 'active'`,
        [
          order.id,
          action,
          plan.id,
          String(plan.name).toLowerCase(),
          billingCycle,
          amount,
          existingSubscription.id,
          userId,
        ],
      );
    }

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: config.razorpayKeyId,
      plan: plan.name,
      billingCycle,
      action,
    });
  } catch (error) {
    console.error('POST /api/payments/create-order error:', error);
    return res.status(500).json({
      error: 'Failed to create payment order.',
    });
  }
});


app.post('/api/payments/verify', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) {
    return res.status(401).json({
      error: 'Authentication required.',
    });
  }

  const userId = req.userId;

  const razorpayOrderId = String(
    req.body?.razorpay_order_id || '',
  ).trim();

  const razorpayPaymentId = String(
    req.body?.razorpay_payment_id || '',
  ).trim();

  const razorpaySignature = String(
    req.body?.razorpay_signature || '',
  ).trim();

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({
      error: 'Payment verification details are required.',
    });
  }

  try {
    /*
     * Find the exact pending order belonging to this user.
     */
    const subscription = await first(
      `SELECT *
       FROM subscriptions
       WHERE partner_id = $1
         AND razorpay_order_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, razorpayOrderId],
    );

    if (!subscription) {
      return res.status(404).json({
        error: 'Payment order was not found.',
      });
    }

    /*
     * Verify Razorpay signature.
     */
    const generatedSignature = createHmac(
      'sha256',
      config.razorpayKeySecret,
    )
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    if (generatedSignature !== razorpaySignature) {
      return res.status(400).json({
        error: 'Payment verification failed.',
      });
    }

    /*
     * Idempotency:
     * same payment cannot activate the subscription twice.
     */
    if (
      subscription.status === 'active' &&
      subscription.razorpay_payment_id === razorpayPaymentId
    ) {
      return res.json({
        success: true,
        message: 'Payment already verified.',
        subscription: {
          id: subscription.id,
          status: subscription.status,
          plan: subscription.plan,
          billingCycle: subscription.billing_cycle,
          amount: subscription.amount,
          startDate: subscription.start_date,
          expiryDate: subscription.expiry_date,
        },
      });
    }

    /*
     * Only pending orders can be activated.
     */
    if (subscription.status !== 'pending') {
      return res.status(400).json({
        error: 'This payment order is no longer pending.',
      });
    }

    const action = String(
      subscription.payment_action || 'initial',
    ).toLowerCase();

    if (!['initial', 'renew', 'upgrade', 'downgrade'].includes(action)) {
      return res.status(400).json({
        error: 'Invalid payment action stored for this order.',
      });
    }

    /*
     * Get the plan attached to this payment order.
     */
    /*
     * The plan attached to the payment order is stored in
     * pending_plan_id. The active plan must remain untouched
     * until payment verification succeeds.
     */
    const selectedPlanId = subscription.pending_plan_id;

    if (!selectedPlanId) {
      return res.status(400).json({
        error: 'Pending payment plan could not be verified.',
      });
    }

    const selectedPlan = await first(
      `SELECT id, name, price, billing_cycle, is_active
       FROM subscription_plans
       WHERE id = $1
       LIMIT 1`,
      [selectedPlanId],
    );

    if (!selectedPlan) {
      return res.status(400).json({
        error: 'Selected subscription plan could not be found.',
      });
    }

    if (!selectedPlan.is_active) {
      return res.status(400).json({
        error: 'Selected subscription plan is no longer active.',
      });
    }

    /*
     * Free Trial must never be activated through Razorpay.
     */
    if (
      String(selectedPlan.name).toLowerCase() === 'free trial'
    ) {
      return res.status(400).json({
        error: 'Free Trial cannot be activated through payment.',
      });
    }

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      /*
       * Lock the subscription row while activating the payment.
       * This prevents two simultaneous verification requests
       * from activating the same order.
       */
      const lockedResult = await client.query(
        `SELECT *
         FROM subscriptions
         WHERE id = $1
           AND partner_id = $2
           AND razorpay_order_id = $3
         FOR UPDATE`,
        [
          subscription.id,
          userId,
          razorpayOrderId,
        ],
      );

      const lockedSubscription = lockedResult.rows[0];

      if (!lockedSubscription) {
        throw new Error('Subscription record could not be locked.');
      }

      if (lockedSubscription.status !== 'pending') {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error: 'This payment order has already been processed.',
        });
      }

      const paymentAction = String(
        lockedSubscription.payment_action || action,
      ).toLowerCase();

      /*
       * INITIAL:
       * New paid subscription starts from payment time.
       *
       * UPGRADE / DOWNGRADE:
       * New selected plan starts from payment time.
       */
      let startDate = new Date();

      /*
       * RENEW:
       * If the current subscription is still active and has a
       * future expiry date, preserve the remaining subscription
       * period and extend from the existing expiry date.
       *
       * If already expired, renewal starts from now.
       */
      if (paymentAction === 'renew') {
        const existingExpiry = lockedSubscription.expiry_date
          ? new Date(lockedSubscription.expiry_date)
          : null;

        if (
          existingExpiry &&
          !Number.isNaN(existingExpiry.getTime()) &&
          existingExpiry.getTime() > startDate.getTime()
        ) {
          startDate = existingExpiry;
        }
      }

      const expiryDate = new Date(startDate);

      if (
        String(selectedPlan.billing_cycle).toLowerCase() === 'yearly'
      ) {
        expiryDate.setFullYear(
          expiryDate.getFullYear() + 1,
        );
      } else {
        expiryDate.setMonth(
          expiryDate.getMonth() + 1,
        );
      }

      /*
       * For renewal, make sure the plan being renewed is the
       * same plan that was active when the order was created.
       */
      if (paymentAction === 'renew') {
        const currentActiveSubscription = await client.query(
          `SELECT s.id, s.plan_id, s.plan, s.status
           FROM subscriptions s
           WHERE s.partner_id = $1
           ORDER BY s.updated_at DESC NULLS LAST,
                    s.created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [userId],
        );

        const current = currentActiveSubscription.rows[0];

        if (!current) {
          throw new Error(
            'Current subscription could not be verified for renewal.',
          );
        }

        if (current.id !== lockedSubscription.id) {
          throw new Error(
            'Renewal order does not belong to the current subscription.',
          );
        }

        if (current.status !== 'pending' && current.status !== 'active' && current.status !== 'expired') {
          throw new Error(
            'Current subscription is not eligible for renewal.',
          );
        }

        if (
          String(current.plan_id) !== String(selectedPlan.id)
        ) {
          throw new Error(
            'Renewal plan no longer matches the current subscription.',
          );
        }
      }

      /*
       * Activate only after signature verification.
       */
      const updatedResult = await client.query(
        `UPDATE subscriptions
         SET plan_id = $1,
             plan = $2,
             billing_cycle = $3,
             status = 'active',
             start_date = $4,
             expiry_date = $5,
             amount = $6,
             razorpay_payment_id = $7,
             razorpay_signature = $8,
             pending_plan_id = NULL,
             pending_plan = NULL,
             pending_billing_cycle = NULL,
             pending_amount = NULL,
             updated_at = NOW()
         WHERE id = $9
           AND partner_id = $10
           AND status = 'pending'
           AND razorpay_order_id = $11
         RETURNING *`,
        [
          selectedPlan.id,
          String(selectedPlan.name).toLowerCase(),
          String(selectedPlan.billing_cycle).toLowerCase(),
          startDate,
          expiryDate,
          Number(selectedPlan.price),
          razorpayPaymentId,
          razorpaySignature,
          lockedSubscription.id,
          userId,
          razorpayOrderId,
        ],
      );

      if (!updatedResult.rows[0]) {
        throw new Error(
          'Subscription could not be activated.',
        );
      }

      const activatedSubscription =
        updatedResult.rows[0];

      /*
       * Invoice is created only after successful activation.
       */
      await client.query(
        `INSERT INTO invoices
         (id, partner_id, invoice_number, invoice_date,
          plan, amount, status)
         VALUES
         ($1, $2, $3, $4, $5, $6, 'paid')`,
        [
          randomUUID(),
          userId,
          `INV-${Date.now()}-${Math.floor(
            1000 + Math.random() * 9000,
          )}`,
          new Date(),
          String(activatedSubscription.plan),
          activatedSubscription.amount,
        ],
      );

      /*
       * Payment notification.
       */
      const actionMessage =
        paymentAction === 'renew'
          ? 'subscription renewed'
          : paymentAction === 'upgrade'
            ? 'subscription upgraded'
            : paymentAction === 'downgrade'
              ? 'subscription changed'
              : 'subscription activated';

      await client.query(
        `INSERT INTO notifications
         (id, partner_id, type, title, message, is_read)
         VALUES
         ($1, $2, $3, $4, $5, FALSE)`,
        [
          randomUUID(),
          userId,
          'payment',
          'Payment Successful',
          `Your ${String(
            activatedSubscription.plan,
          )} subscription has been ${actionMessage} and is active until ${expiryDate.toISOString()}.`,
        ],
      );

      await client.query('COMMIT');

      return res.json({
        success: true,
        message: 'Payment verified and subscription activated.',
        subscription: {
          id: activatedSubscription.id,
          status: activatedSubscription.status,
          plan: activatedSubscription.plan,
          billingCycle:
            activatedSubscription.billing_cycle,
          amount: activatedSubscription.amount,
          startDate:
            activatedSubscription.start_date,
          expiryDate:
            activatedSubscription.expiry_date,
          paymentAction,
        },
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(
      'POST /api/payments/verify error:',
      error,
    );

    return res.status(500).json({
      error: 'Failed to verify payment.',
    });
  }
});

app.patch('/api/me', async (req: AuthenticatedRequest, res) => {
  try {
    const allowed = [
      'owner_name',
      'restaurant_name',
      'phone',
      'restaurant_type',
      'number_of_branches',
      'city',
      'business_name',
      'gst_number',
      'business_type',
    ];

    const entries = Object.entries(req.body).filter(([key]) =>
      allowed.includes(key)
    );

    for (const [key, value] of entries) {
      await db.query(
        `UPDATE partners SET ${key}=$1, updated_at=NOW() WHERE id=$2`,
        [value, req.userId]
      );
    }

    const partner = await first(
      'SELECT * FROM partners WHERE id=$1',
      [req.userId]
    );

    return res.json({ partner });
  } catch (error) {
    console.error('PATCH /api/me error:', error);

    return res.status(500).json({
      error: 'Failed to update user profile.',
    });
  }
});

/**
 * Compatibility endpoint:
 * Frontend currently sends POST /api/me.
 * Keep this endpoint until frontend is changed to PATCH.
 */
app.post('/api/me', async (req: AuthenticatedRequest, res) => {
  try {
    const allowed = [
      'owner_name',
      'restaurant_name',
      'phone',
      'restaurant_type',
      'number_of_branches',
      'city',
      'business_name',
      'gst_number',
      'business_type',
    ];

    const entries = Object.entries(req.body).filter(([key]) =>
      allowed.includes(key)
    );

    for (const [key, value] of entries) {
      await db.query(
        `UPDATE partners SET ${key}=$1, updated_at=NOW() WHERE id=$2`,
        [value, req.userId]
      );
    }

    const partner = await first(
      'SELECT * FROM partners WHERE id=$1',
      [req.userId]
    );

    return res.json({ partner });
  } catch (error) {
    console.error('POST /api/me error:', error);

    return res.status(500).json({
      error: 'Failed to update user profile.',
    });
  }
});

app.post('/api/subscriptions/start-trial', async (req: AuthenticatedRequest, res) => {
  if (!req.userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required.',
    });
  }

  const userId = req.userId;

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const partnerResult = await client.query(
      `SELECT id, free_trial_used_at
       FROM partners
       WHERE id = $1
       FOR UPDATE`,
      [userId],
    );

    const partner = partnerResult.rows[0];

    if (!partner) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        success: false,
        message: 'Restaurant account not found.',
      });
    }

    if (partner.free_trial_used_at) {
      await client.query('ROLLBACK');

      return res.status(403).json({
        success: false,
        code: 'FREE_TRIAL_ALREADY_USED',
        message: 'Free Trial has already been used.',
      });
    }

    const trialPlanResult = await client.query(
      `SELECT id, name, price, billing_cycle, trial_days
       FROM subscription_plans
       WHERE LOWER(name) = 'free trial'
         AND is_active = TRUE
       LIMIT 1`,
    );

    const trialPlan = trialPlanResult.rows[0];

    if (!trialPlan) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        success: false,
        message: 'Free Trial plan is not available.',
      });
    }

    const trialDays =
      Number(trialPlan.trial_days) > 0
        ? Number(trialPlan.trial_days)
        : 14;

    if (trialDays !== 14) {
      await client.query('ROLLBACK');

      return res.status(500).json({
        success: false,
        message: 'Free Trial configuration must be exactly 14 days.',
      });
    }

    const startDate = new Date();
    const expiryDate = new Date(startDate);
    expiryDate.setDate(expiryDate.getDate() + 14);

    const existingSubscriptionResult = await client.query(
      `SELECT id, status, plan_id, plan, amount, expiry_date
       FROM subscriptions
       WHERE partner_id = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [userId],
    );

    const existingSubscription =
      existingSubscriptionResult.rows[0];

    /*
     * Never overwrite an active paid subscription with Free Trial.
     */
    if (
      existingSubscription &&
      String(existingSubscription.status).toLowerCase() === 'active'
    ) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        success: false,
        code: 'ACTIVE_SUBSCRIPTION_EXISTS',
        message: 'An active subscription already exists.',
      });
    }

    let subscription;

    if (existingSubscription) {
      const subscriptionResult = await client.query(
        `UPDATE subscriptions
         SET plan_id = $1,
             plan = $2,
             billing_cycle = $3,
             status = 'trial',
             start_date = $4,
             expiry_date = $5,
             auto_renew = FALSE,
             amount = 0,
             razorpay_order_id = NULL,
             razorpay_payment_id = NULL,
             razorpay_signature = NULL,
             updated_at = NOW()
         WHERE id = $6
           AND partner_id = $7
         RETURNING *`,
        [
          trialPlan.id,
          String(trialPlan.name).toLowerCase(),
          trialPlan.billing_cycle || 'monthly',
          startDate,
          expiryDate,
          existingSubscription.id,
          userId,
        ],
      );

      subscription = subscriptionResult.rows[0];
    } else {
      const subscriptionResult = await client.query(
        `INSERT INTO subscriptions
         (id, partner_id, plan_id, plan, billing_cycle, status,
          start_date, expiry_date, auto_renew, amount)
         VALUES ($1, $2, $3, $4, $5, 'trial', $6, $7, FALSE, 0)
         RETURNING *`,
        [
          randomUUID(),
          userId,
          trialPlan.id,
          String(trialPlan.name).toLowerCase(),
          trialPlan.billing_cycle || 'monthly',
          startDate,
          expiryDate,
        ],
      );

      subscription = subscriptionResult.rows[0];
    }

    if (!subscription) {
      throw new Error('Unable to create Free Trial subscription.');
    }

    await client.query(
      `UPDATE partners
       SET free_trial_used_at = NOW(),
           status = 'active',
           updated_at = NOW()
       WHERE id = $1`,
      [userId],
    );

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      message: 'Free Trial activated successfully.',
      subscription,
      trial: {
        startDate,
        expiryDate,
        durationDays: 14,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('POST /api/subscriptions/start-trial error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to activate Free Trial.',
    });
  } finally {
    client.release();
  }
});

app.post('/api/onboarding/complete', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { owner_name, phone, restaurant_name, restaurant_type, city, business_name, gst_number, business_type, branch_count, branch_city } = req.body;
  const required = { owner_name, phone, restaurant_name, restaurant_type, city, business_name, gst_number, business_type, branch_city };
  if (Object.values(required).some((value) => typeof value !== 'string' || !value.trim()) || !Number.isInteger(Number(branch_count)) || Number(branch_count) < 1) {
    return res.status(400).json({ error: 'Complete all required onboarding details before continuing.' });
  }
  try {
    const subscription = await first(
      `SELECT
         s.status,
         p.name AS plan_name,
         p.max_branches
       FROM subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.partner_id = $1
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [req.userId],
    );

    const requestedBranches = Number(branch_count);

    if (
      subscription?.max_branches !== null &&
      subscription?.max_branches !== undefined &&
      requestedBranches > Number(subscription.max_branches)
    ) {
      return res.status(400).json({
        error: 'Branch limit exceeded for your subscription plan.',
        code: 'MAX_BRANCHES_EXCEEDED',
        plan: subscription.plan_name,
        maxBranches: Number(subscription.max_branches),
        requestedBranches,
      });
    }

    const status = subscription?.status === 'active' ? 'active' : 'trial';

    const partner = await first(
      "UPDATE partners SET owner_name=$1,phone=$2,restaurant_name=$3,restaurant_type=$4,city=$5,business_name=$6,gst_number=$7,business_type=$8,number_of_branches=$9,status=$10,onboarding_status='completed',onboarding_completed=TRUE,updated_at=NOW() WHERE id=$11 RETURNING *",
      [
        owner_name.trim(),
        phone.trim(),
        restaurant_name.trim(),
        restaurant_type.trim(),
        city.trim(),
        business_name.trim(),
        gst_number.trim(),
        business_type.trim(),
        requestedBranches,
        status,
        req.userId,
      ],
    );
    if (!partner) return res.status(404).json({ error: 'Restaurant account not found.' });
    return res.json({ partner, onboarding_completed: true });
  } catch {
    return res.status(500).json({ error: 'Unable to complete onboarding. Please try again.' });
  }
});
app.get('/api/dashboard', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = req.userId;
  if (!id) return res.status(401).json({ error: 'Unauthorized' });
  await expireSubscriptions(id);
    const [partner, subscription, invoices, tickets, notifications] = await Promise.all([
    first('SELECT * FROM partners WHERE id=$1', [id]),
    first(
      `SELECT s.*, p.name AS plan_name, p.price, p.billing_cycle AS plan_billing_cycle, p.max_users, p.max_branches, p.features
       FROM subscriptions s
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.partner_id = $1
       ORDER BY CASE
         WHEN s.status = 'active' THEN 1
         WHEN s.status = 'trial' THEN 2
         ELSE 3
       END,
       s.updated_at DESC NULLS LAST,
       s.created_at DESC
       LIMIT 1`,
      [id]
    ),
    db.query('SELECT * FROM invoices WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 5', [id]),
    db.query('SELECT * FROM support_tickets WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 5', [id]),
    db.query('SELECT * FROM notifications WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 5', [id]),
  ]);
  res.json({
    partner,
    subscription,
    invoices: invoices.rows,
    tickets: tickets.rows,
    notifications: notifications.rows,
  });
});

app.get('/api/subscription', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  await expireSubscriptions(req.userId);
  const sub = await first(
    `SELECT s.*, p.name AS plan_name, p.price, p.billing_cycle AS plan_billing_cycle, p.max_users, p.max_branches, p.features
     FROM subscriptions s
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.partner_id = $1
     ORDER BY CASE
       WHEN s.status = 'active' THEN 1
       WHEN s.status = 'trial' THEN 2
       ELSE 3
     END,
     s.updated_at DESC NULLS LAST,
     s.created_at DESC
     LIMIT 1`,
    [req.userId]
  );
  res.json({ subscription: sub });
});

app.patch('/api/subscription', requireAuth, async (req: AuthenticatedRequest, res) => {
  return res.status(403).json({
    success: false,
    message: 'Subscription changes must be completed through the payment flow.',
  });
});

app.get('/api/invoices', requireAuth, async (req: AuthenticatedRequest, res) => res.json({ invoices: (await db.query('SELECT * FROM invoices WHERE partner_id=$1 ORDER BY created_at DESC', [req.userId])).rows }));
app.get('/api/notifications', requireAuth, async (req: AuthenticatedRequest, res) => res.json({ notifications: (await db.query('SELECT * FROM notifications WHERE partner_id=$1 ORDER BY created_at DESC', [req.userId])).rows }));
app.patch('/api/notifications/:id/read', requireAuth, async (req: AuthenticatedRequest, res) => {
  await db.query('UPDATE notifications SET is_read=TRUE WHERE id=$1 AND partner_id=$2', [req.params.id, req.userId]);
  res.json({ ok: true });
});
app.delete('/api/notifications/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  await db.query('DELETE FROM notifications WHERE id=$1 AND partner_id=$2', [req.params.id, req.userId]);
  res.status(204).send();
});
app.get('/api/documents', requireAuth, async (req: AuthenticatedRequest, res) => res.json({ documents: (await db.query('SELECT * FROM documents WHERE partner_id=$1 ORDER BY created_at DESC', [req.userId])).rows }));
app.post('/api/documents', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { file_name, file_type, document_type } = req.body;
  if (!file_name || !document_type) return res.status(400).json({ error: 'file_name and document_type are required.' });
  const document = await first('INSERT INTO documents (id,partner_id,file_name,file_type,document_type) VALUES ($1,$2,$3,$4,$5) RETURNING *', [randomUUID(), req.userId, file_name, file_type, document_type]);
  res.status(201).json({ document });
});
app.delete('/api/documents/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  await db.query('DELETE FROM documents WHERE id=$1 AND partner_id=$2', [req.params.id, req.userId]);
  res.status(204).send();
});
app.get('/api/support/tickets', requireAuth, async (req: AuthenticatedRequest, res) => res.json({ tickets: (await db.query('SELECT * FROM support_tickets WHERE partner_id=$1 ORDER BY created_at DESC', [req.userId])).rows }));
app.post('/api/support/tickets', requireAuth, async (req: AuthenticatedRequest, res) => {
  const parsed = ticketSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid ticket.' });
  const t = parsed.data;
  const ticket = await first('INSERT INTO support_tickets (id,partner_id,ticket_number,subject,category,priority,message) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [randomUUID(), req.userId, referenceId('TKT'), t.subject, t.category, t.priority, t.message]);
  res.status(201).json({ ticket });
});

app.get('/api/ticket_replies', requireAuth, async (req: AuthenticatedRequest, res) => {
  const ticketId = req.query.ticket_id as string;
  if (!ticketId) return res.status(400).json({ error: 'ticket_id is required' });
  const ticket = await first('SELECT id FROM support_tickets WHERE id=$1 AND partner_id=$2', [ticketId, req.userId]);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  const replies = await db.query('SELECT * FROM ticket_replies WHERE ticket_id=$1 ORDER BY created_at ASC', [ticketId]);
  res.json({ replies: replies.rows });
});

app.post('/api/ticket_replies', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { ticket_id, message, attachment_url } = req.body;
  if (!ticket_id || !message?.trim()) return res.status(400).json({ error: 'ticket_id and message are required.' });
  const ticket = await first('SELECT id FROM support_tickets WHERE id=$1 AND partner_id=$2', [ticket_id, req.userId]);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  const reply = await first(
    'INSERT INTO ticket_replies (id, ticket_id, sender_type, message, attachment_url) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [randomUUID(), ticket_id, 'customer', message.trim(), attachment_url || null]
  );
  res.status(201).json({ reply });
});

// ============================================================
// RESTAURANT INVENTORY & MANAGEMENT API (100% TENANT ISOLATED)
// ============================================================
const ALLOWED_RESTO_TABLES = new Set([
  'branches',
  'restaurant_users',
  'categories',
  'units',
  'unit_conversions',
  'suppliers',
  'inventory_items',
  'stock_transactions',
  'purchase_orders',
  'purchase_order_items',
  'stock_receipts',
  'stock_receipt_items',
  'purchase_returns',
  'purchase_return_items',
  'stock_issues',
  'stock_transfers',
  'stock_transfer_items',
  'stock_adjustments',
  'stock_adjustment_items',
  'stock_counts',
  'stock_count_items',
  'kitchen_requisitions',
  'kitchen_requisition_items',
  'recipes',
  'recipe_ingredients',
  'menu_items',
  'wastage_records',
  'activity_logs',
  'restaurants',
  'subscriptions',
  'notifications',
]);

app.get('/api/resto/:table', requireAuth, async (req: AuthenticatedRequest, res) => {
  const table = String(req.params.table || '');
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!ALLOWED_RESTO_TABLES.has(table)) {
    return res.status(400).json({ error: `Unknown resource: ${table}` });
  }

  if (table === 'restaurants') {
    const partner = await first('SELECT * FROM partners WHERE id = $1', [partnerId]);
    if (!partner) return res.json({ data: [] });
    const rest = {
      id: partner.id,
      name: partner.restaurant_name,
      legal_name: partner.business_name || partner.restaurant_name,
      gst_number: partner.gst_number || null,
      phone: partner.phone || null,
      email: partner.email,
      address: partner.city || '',
      city: partner.city || '',
      state: '',
      postal_code: '',
      country: 'India',
      currency: 'INR',
      logo_url: null,
      status: 'active',
      created_at: partner.created_at,
      updated_at: partner.updated_at,
    };
    return res.json({ data: [rest] });
  }

  if (table === 'subscriptions') {
    await expireSubscriptions(partnerId);
    const sub = await first(
      `SELECT s.*, sp.name AS plan_name, sp.price, sp.billing_cycle AS plan_billing_cycle, sp.max_users, sp.max_branches
       FROM subscriptions s
       LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.partner_id = $1
       ORDER BY CASE
         WHEN s.status = 'active' THEN 1
         WHEN s.status = 'trial' THEN 2
         ELSE 3
       END,
       s.updated_at DESC NULLS LAST,
       s.created_at DESC
       LIMIT 1`,
      [partnerId]
    );
    if (!sub) return res.json({ data: [] });
    const planName = (sub.plan_name || sub.plan || 'basic').toLowerCase();
    const defaultBranches = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : 2;
    const defaultUsers = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : 2;
    const mappedSub = {
      id: sub.id,
      restaurant_id: partnerId,
      plan: planName,
      status: sub.status || 'active',
      start_date: sub.start_date ? new Date(sub.start_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      expiry_date: sub.expiry_date ? new Date(sub.expiry_date).toISOString().slice(0, 10) : null,
      billing_cycle: sub.billing_cycle || sub.plan_billing_cycle || 'monthly',
      amount: Number(sub.price ?? sub.amount ?? 0),
      currency: 'INR',
      auto_renewal: Boolean(sub.auto_renew),
      max_branches: sub.max_branches ?? defaultBranches,
      max_users: sub.max_users ?? defaultUsers,
      created_at: sub.created_at,
      updated_at: sub.updated_at || sub.created_at,
    };
    return res.json({ data: [mappedSub] });
  }

  const values: any[] = [partnerId];
  let whereClause = `WHERE restaurant_id = $1`;

  const validColRegex = /^[a-z0-9_]+$/i;
  for (const [key, val] of Object.entries(req.query)) {
    if (['order', 'limit', 'select', 'offset'].includes(key)) continue;
    if (key === 'restaurant_id') continue;
    if (validColRegex.test(key) && val !== undefined) {
      values.push(val);
      whereClause += ` AND ${key} = $${values.length}`;
    }
  }

  let orderClause = '';
  if (typeof req.query.order === 'string') {
    const parts = req.query.order.split('.');
    const col = parts[0];
    const dir = parts[1]?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    if (validColRegex.test(col)) {
      orderClause = ` ORDER BY ${col} ${dir}`;
    }
  } else {
    orderClause = ` ORDER BY created_at DESC`;
  }

  let limitClause = '';
  if (req.query.limit && !isNaN(Number(req.query.limit))) {
    limitClause = ` LIMIT ${Math.min(1000, Number(req.query.limit))}`;
  }

  const querySql = `SELECT * FROM ${table} ${whereClause}${orderClause}${limitClause}`;
  const result = await db.query(querySql, values);
  const rows = result.rows;

  if (table === 'inventory_items' && rows.length > 0) {
    const [cats, units, supps] = await Promise.all([
      db.query('SELECT * FROM categories WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM units WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM suppliers WHERE restaurant_id = $1', [partnerId]),
    ]);
    const catMap = Object.fromEntries(cats.rows.map(c => [c.id, c]));
    const unitMap = Object.fromEntries(units.rows.map(u => [u.id, u]));
    const suppMap = Object.fromEntries(supps.rows.map(s => [s.id, s]));
    for (const row of rows) {
      row.category = catMap[row.category_id] || null;
      row.unit = unitMap[row.unit_id] || null;
      row.supplier = suppMap[row.supplier_id] || null;
    }
  } else if (table === 'stock_transactions' && rows.length > 0) {
    const items = await db.query('SELECT * FROM inventory_items WHERE restaurant_id = $1', [partnerId]);
    const itemMap = Object.fromEntries(items.rows.map(i => [i.id, i]));
    for (const row of rows) {
      row.item = itemMap[row.item_id] || null;
    }
  } else if ((table === 'stock_receipts' || table === 'purchase_orders' || table === 'purchase_returns') && rows.length > 0) {
    const supps = await db.query('SELECT * FROM suppliers WHERE restaurant_id = $1', [partnerId]);
    const suppMap = Object.fromEntries(supps.rows.map(s => [s.id, s]));
    for (const row of rows) {
      row.supplier = suppMap[row.supplier_id] || null;
    }
  } else if (table === 'wastage_records' && rows.length > 0) {
    const items = await db.query('SELECT * FROM inventory_items WHERE restaurant_id = $1', [partnerId]);
    const itemMap = Object.fromEntries(items.rows.map(i => [i.id, i]));
    for (const row of rows) {
      row.item = itemMap[row.item_id] || null;
    }
  } else if (table === 'unit_conversions' && rows.length > 0) {
    const units = await db.query('SELECT * FROM units WHERE restaurant_id = $1', [partnerId]);
    const unitMap = Object.fromEntries(units.rows.map(u => [u.id, u]));
    for (const row of rows) {
      row.from_unit = unitMap[row.from_unit_id] || null;
      row.to_unit = unitMap[row.to_unit_id] || null;
    }
  }

  return res.json({ data: rows });
});

app.post('/api/resto/:table', requireAuth, async (req: AuthenticatedRequest, res) => {
  const table = String(req.params.table || '');
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!ALLOWED_RESTO_TABLES.has(table)) {
    return res.status(400).json({ error: `Unknown resource: ${table}` });
  }

  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];

    if (table === 'branches') {
      const sub = await first(
        `SELECT s.*, p.max_branches, p.name AS plan_name
         FROM subscriptions s
         LEFT JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.partner_id = $1
         ORDER BY CASE
           WHEN s.status = 'active' THEN 1
           WHEN s.status = 'trial' THEN 2
           ELSE 3
         END,
         s.updated_at DESC NULLS LAST,
         s.created_at DESC
         LIMIT 1`,
        [partnerId]
      );
      const planName = (sub?.plan_name || sub?.plan || 'basic').toLowerCase();
      const defaultBranches = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : 2;
      const maxBranches = Number(sub?.max_branches ?? defaultBranches);

      const countRes = await db.query('SELECT COUNT(*) FROM branches WHERE restaurant_id = $1', [partnerId]);
      const currentBranches = parseInt(countRes.rows[0]?.count || '0', 10);

      const newBranches = items.filter((i: any) => !i.id);
      if (maxBranches < 9999 && (currentBranches + newBranches.length) > maxBranches) {
        return res.status(403).json({
          error: `Your ${sub?.plan_name || 'current'} subscription plan allows up to ${maxBranches} units/branches. You have already created ${currentBranches} units. Please upgrade your plan to add more.`,
          code: 'BRANCH_LIMIT_EXCEEDED',
          limit: maxBranches,
          current: currentBranches,
        });
      }
    }

    if (table === 'restaurant_users') {
      const sub = await first(
        `SELECT s.*, p.max_users, p.name AS plan_name
         FROM subscriptions s
         LEFT JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.partner_id = $1
         ORDER BY CASE
           WHEN s.status = 'active' THEN 1
           WHEN s.status = 'trial' THEN 2
           ELSE 3
         END,
         s.updated_at DESC NULLS LAST,
         s.created_at DESC
         LIMIT 1`,
        [partnerId]
      );
      const planName = (sub?.plan_name || sub?.plan || 'basic').toLowerCase();
      const defaultUsers = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : 2;
      const maxUsers = Number(sub?.max_users ?? defaultUsers);

      const countRes = await db.query('SELECT COUNT(*) FROM restaurant_users WHERE restaurant_id = $1', [partnerId]);
      const currentUsers = parseInt(countRes.rows[0]?.count || '0', 10);

      const newUsers = items.filter((i: any) => !i.id);
      if (maxUsers < 9999 && (currentUsers + newUsers.length) > maxUsers) {
        return res.status(403).json({
          error: `Your ${sub?.plan_name || 'current'} subscription plan allows up to ${maxUsers} users. You have already used all ${currentUsers} user slots. Please upgrade your plan to add more team members.`,
          code: 'USER_LIMIT_EXCEEDED',
          limit: maxUsers,
          current: currentUsers,
        });
      }

      // Validate each user before inserting
      for (const rawItem of items) {
        if (!rawItem.full_name || typeof rawItem.full_name !== 'string' || !rawItem.full_name.trim()) {
          return res.status(400).json({ error: 'Full name is required.', code: 'INVALID_NAME' });
        }
        if (!rawItem.email || typeof rawItem.email !== 'string' || !rawItem.email.trim() || !rawItem.email.includes('@')) {
          return res.status(400).json({ error: 'Valid email address is required.', code: 'INVALID_EMAIL' });
        }
        if (!rawItem.role || typeof rawItem.role !== 'string' || !rawItem.role.trim()) {
          return res.status(400).json({ error: 'Role is required.', code: 'INVALID_ROLE' });
        }

        const emailLower = rawItem.email.trim().toLowerCase();
        const existing = await first(
          'SELECT id FROM restaurant_users WHERE restaurant_id = $1 AND LOWER(email) = $2',
          [partnerId, emailLower]
        );
        if (existing && (!rawItem.id || existing.id !== rawItem.id)) {
          return res.status(409).json({
            error: `A team member with email "${emailLower}" already exists in your restaurant.`,
            code: 'DUPLICATE_EMAIL',
          });
        }

        // Validate branch ownership if branch_id provided
        if (rawItem.branch_id && rawItem.branch_id !== 'all' && String(rawItem.branch_id).trim()) {
          const branchRow = await first(
            'SELECT id FROM branches WHERE id = $1 AND restaurant_id = $2',
            [String(rawItem.branch_id).trim(), partnerId]
          );
          if (!branchRow) {
            return res.status(400).json({
              error: 'Selected branch does not belong to your restaurant.',
              code: 'INVALID_BRANCH',
            });
          }
        }
      }
    }

    const inserted: any[] = [];

    for (const rawItem of items) {
      const item = { ...rawItem };
      const id = item.id || randomUUID();
      item.id = id;
      if (table !== 'partners' && table !== 'restaurants') {
        item.restaurant_id = partnerId;
        if (table === 'suppliers') {
          item.partner_id = partnerId;
        }
      }


      // Foreign key & empty string sanitization
      if ('branch_id' in item && (!item.branch_id || item.branch_id === 'all' || !String(item.branch_id).trim())) {
        item.branch_id = null;
      }
      if ('supplier_id' in item && (!item.supplier_id || !String(item.supplier_id).trim())) {
        item.supplier_id = null;
      }
      if ('category_id' in item && (!item.category_id || !String(item.category_id).trim())) {
        item.category_id = null;
      }
      if ('unit_id' in item && (!item.unit_id || !String(item.unit_id).trim())) {
        item.unit_id = null;
      }
      if ('phone' in item && (!item.phone || !String(item.phone).trim())) {
        item.phone = null;
      }
      if ('auth_user_id' in item && (!item.auth_user_id || !String(item.auth_user_id).trim())) {
        item.auth_user_id = null;
      }

      const keys = Object.keys(item).filter(k => k !== 'category' && k !== 'unit' && k !== 'supplier' && k !== 'item' && k !== 'from_unit' && k !== 'to_unit' && k !== 'items');
      const cols = keys.map(k => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const vals = keys.map(k => {
        const v = item[k];
        if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
          return JSON.stringify(v);
        }
        return v;
      });

      const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${keys.map(k => `"${k}" = EXCLUDED."${k}"`).join(', ')} RETURNING *`;
      const row = await first(sql, vals);
      inserted.push(row);
    }

    return res.status(201).json({ data: Array.isArray(req.body) ? inserted : inserted[0] });
  } catch (err: any) {
    console.error(`Error in POST /api/resto/${table}:`, err);
    return res.status(500).json({ error: err?.message || 'Database error occurred while creating record' });
  }
});

app.patch('/api/resto/:table', requireAuth, async (req: AuthenticatedRequest, res) => {
  const table = String(req.params.table || '');
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!ALLOWED_RESTO_TABLES.has(table)) {
    return res.status(400).json({ error: `Unknown resource: ${table}` });
  }

  const id = (req.query.id || req.body?.id) as string;
  if (!id) return res.status(400).json({ error: 'ID is required for update' });

  try {
    if (table === 'restaurants') {
      const { name, legal_name, phone, address, city } = req.body || {};
      const updated = await first(
        `UPDATE partners SET restaurant_name = COALESCE($1, restaurant_name), business_name = COALESCE($2, business_name), phone = COALESCE($3, phone), city = COALESCE($4, city), updated_at = NOW() WHERE id = $5 RETURNING *`,
        [name, legal_name, phone, city || address, partnerId]
      );
      return res.json({ data: updated });
    }

    const item = { ...req.body };
    delete item.id;
    delete item.restaurant_id;
    delete item.category;
    delete item.unit;
    delete item.supplier;
    delete item.item;
    delete item.from_unit;
    delete item.to_unit;
    delete item.items;

    // Foreign key & empty string sanitization
    if ('branch_id' in item && (!item.branch_id || item.branch_id === 'all' || !String(item.branch_id).trim())) {
      item.branch_id = null;
    } else if ('branch_id' in item && item.branch_id) {
      const branchRow = await first(
        'SELECT id FROM branches WHERE id = $1 AND restaurant_id = $2',
        [String(item.branch_id).trim(), partnerId]
      );
      if (!branchRow) {
        return res.status(400).json({ error: 'Selected branch does not belong to your restaurant.' });
      }
    }

    if ('supplier_id' in item && (!item.supplier_id || !String(item.supplier_id).trim())) {
      item.supplier_id = null;
    }
    if ('category_id' in item && (!item.category_id || !String(item.category_id).trim())) {
      item.category_id = null;
    }
    if ('unit_id' in item && (!item.unit_id || !String(item.unit_id).trim())) {
      item.unit_id = null;
    }
    if ('phone' in item && (!item.phone || !String(item.phone).trim())) {
      item.phone = null;
    }

    const keys = Object.keys(item);
    if (keys.length === 0) return res.json({ data: null });

    const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const vals = keys.map(k => {
      const v = item[k];
      if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
        return JSON.stringify(v);
      }
      return v;
    });
    vals.push(id);
    vals.push(partnerId);

    const sql = `UPDATE ${table} SET ${setClauses} WHERE id = $${vals.length - 1} AND restaurant_id = $${vals.length} RETURNING *`;
    const updated = await first(sql, vals);
    return res.json({ data: updated });
  } catch (err: any) {
    console.error(`Error in PATCH /api/resto/${table}:`, err);
    return res.status(500).json({ error: err?.message || 'Database error occurred while updating record' });
  }
});

app.delete('/api/resto/:table', requireAuth, async (req: AuthenticatedRequest, res) => {
  const table = String(req.params.table || '');
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!ALLOWED_RESTO_TABLES.has(table)) {
    return res.status(400).json({ error: `Unknown resource: ${table}` });
  }

  const id = (req.query.id || req.body?.id) as string;
  if (!id) return res.status(400).json({ error: 'ID is required for delete' });

  try {
    await db.query(`DELETE FROM ${table} WHERE id = $1 AND restaurant_id = $2`, [id, partnerId]);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    console.error(`Error in DELETE /api/resto/${table}:`, err);
    return res.status(500).json({ error: err?.message || 'Database error occurred while deleting record' });
  }
});

// ============================================================
// RESTAURANT USERS (STAFF) MANAGEMENT API (100% TENANT ISOLATED)
// ============================================================

// GET /api/restaurant-users
app.get('/api/restaurant-users', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ success: false, message: 'Authentication required' });

  try {
    const users = await db.query(
      `SELECT ru.id, ru.restaurant_id, ru.full_name, ru.email, ru.phone, ru.role, ru.status, ru.permissions, ru.branch_id, ru.created_at, ru.updated_at,
              b.name AS branch_name
       FROM restaurant_users ru
       LEFT JOIN branches b ON b.id = ru.branch_id
       WHERE ru.restaurant_id = $1
       ORDER BY ru.created_at DESC`,
      [partnerId]
    );
    return res.json({
      success: true,
      data: users.rows,
      users: users.rows,
      count: users.rows.length,
    });
  } catch (err: any) {
    console.error('Error fetching restaurant users:', err);
    return res.status(500).json({ success: false, message: 'Unable to process request' });
  }
});

// GET /api/restaurant-users/:id
app.get('/api/restaurant-users/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ success: false, message: 'Authentication required' });
  const { id } = req.params;

  try {
    const user = await first(
      `SELECT ru.id, ru.restaurant_id, ru.full_name, ru.email, ru.phone, ru.role, ru.status, ru.permissions, ru.branch_id, ru.created_at, ru.updated_at,
              b.name AS branch_name
       FROM restaurant_users ru
       LEFT JOIN branches b ON b.id = ru.branch_id
       WHERE ru.id = $1 AND ru.restaurant_id = $2`,
      [id, partnerId]
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, data: user, user });
  } catch (err: any) {
    console.error('Error fetching restaurant user:', err);
    return res.status(500).json({ success: false, message: 'Unable to process request' });
  }
});

// POST /api/restaurant-users
app.post('/api/restaurant-users', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ success: false, message: 'Authentication required' });
  const { full_name, email, phone, role, branch_id, status, permissions } = req.body || {};

  // 1. Required string validation
  if (!full_name || typeof full_name !== 'string' || !full_name.trim()) {
    return res.status(400).json({ success: false, message: 'Full name is required.', code: 'INVALID_NAME' });
  }
  if (!email || typeof email !== 'string' || !email.trim() || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email address is required.', code: 'INVALID_EMAIL' });
  }
  if (!role || typeof role !== 'string' || !role.trim()) {
    return res.status(400).json({ success: false, message: 'Role is required.', code: 'INVALID_ROLE' });
  }

  const emailLower = email.trim().toLowerCase();

  try {
    // 2. Branch ownership validation
    let branchIdValue: string | null = null;
    if (branch_id && branch_id !== 'all' && String(branch_id).trim()) {
      const branchRow = await first(
        'SELECT id FROM branches WHERE id = $1 AND restaurant_id = $2',
        [String(branch_id).trim(), partnerId]
      );
      if (!branchRow) {
        return res.status(400).json({
          success: false,
          message: 'Selected branch does not belong to your restaurant.',
          code: 'INVALID_BRANCH',
        });
      }
      branchIdValue = branchRow.id;
    }

    // 3. Duplicate email check within tenant
    const existing = await first(
      'SELECT id FROM restaurant_users WHERE restaurant_id = $1 AND LOWER(email) = $2',
      [partnerId, emailLower]
    );
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `A team member with email "${emailLower}" already exists in your restaurant.`,
        code: 'DUPLICATE_EMAIL',
      });
    }

    // 4. Subscription plan capacity check
    const sub = await first(
      `SELECT s.*, p.max_users, p.name AS plan_name
       FROM subscriptions s
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.partner_id = $1
       ORDER BY CASE
         WHEN s.status = 'active' THEN 1
         WHEN s.status = 'trial' THEN 2
         ELSE 3
       END,
       s.updated_at DESC NULLS LAST,
       s.created_at DESC
       LIMIT 1`,
      [partnerId]
    );
    const planName = (sub?.plan_name || sub?.plan || 'basic').toLowerCase();
    const defaultUsers = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : 2;
    const maxUsers = Number(sub?.max_users ?? defaultUsers);

    const countRes = await db.query('SELECT COUNT(*) FROM restaurant_users WHERE restaurant_id = $1', [partnerId]);
    const currentUsers = parseInt(countRes.rows[0]?.count || '0', 10);

    if (maxUsers < 9999 && currentUsers >= maxUsers) {
      return res.status(403).json({
        success: false,
        message: `Your ${sub?.plan_name || 'current'} subscription plan allows up to ${maxUsers} users. You have already used all ${currentUsers} user slots. Please upgrade your plan to add more team members.`,
        code: 'MAX_USERS_EXCEEDED',
        limit: maxUsers,
        current: currentUsers,
      });
    }

    const id = randomUUID();
    const userStatus = status || 'active';
    const userPermissions = Array.isArray(permissions) ? permissions : [];

    const user = await first(
      `INSERT INTO restaurant_users (id, restaurant_id, full_name, email, phone, role, status, permissions, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [id, partnerId, full_name.trim(), emailLower, phone ? String(phone).trim() : null, role.trim(), userStatus, JSON.stringify(userPermissions), branchIdValue]
    );

    return res.status(201).json({
      success: true,
      data: user,
      user,
      message: 'User created successfully.',
    });
  } catch (err: any) {
    console.error('Error creating restaurant user:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to create user.' });
  }
});


// PATCH /api/restaurant-users/:id
app.patch('/api/restaurant-users/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ success: false, message: 'Authentication required' });
  const { id } = req.params;

  try {
    const existing = await first(
      'SELECT * FROM restaurant_users WHERE id = $1 AND restaurant_id = $2',
      [id, partnerId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'User not found' });

    const { full_name, email, phone, role, branch_id, status, permissions } = req.body || {};

    let updatedName = existing.full_name;
    if (full_name !== undefined) {
      if (typeof full_name !== 'string' || !full_name.trim()) {
        return res.status(400).json({ success: false, message: 'Full name cannot be empty', code: 'INVALID_NAME' });
      }
      updatedName = full_name.trim();
    }

    let updatedEmail = existing.email;
    if (email !== undefined) {
      if (typeof email !== 'string' || !email.trim() || !email.includes('@')) {
        return res.status(400).json({ success: false, message: 'Valid email address is required', code: 'INVALID_EMAIL' });
      }
      const emailLower = email.trim().toLowerCase();
      if (emailLower !== existing.email.toLowerCase()) {
        const dup = await first(
          'SELECT id FROM restaurant_users WHERE restaurant_id = $1 AND LOWER(email) = $2 AND id != $3',
          [partnerId, emailLower, id]
        );
        if (dup) {
          return res.status(409).json({ success: false, message: `A user with email "${emailLower}" already exists.`, code: 'DUPLICATE_EMAIL' });
        }
      }
      updatedEmail = emailLower;
    }

    let updatedBranchId = existing.branch_id;
    if (branch_id !== undefined) {
      if (!branch_id || branch_id === 'all' || !String(branch_id).trim()) {
        updatedBranchId = null;
      } else {
        const branchRow = await first(
          'SELECT id FROM branches WHERE id = $1 AND restaurant_id = $2',
          [String(branch_id).trim(), partnerId]
        );
        if (!branchRow) {
          return res.status(400).json({ success: false, message: 'Selected branch does not belong to your restaurant.', code: 'INVALID_BRANCH' });
        }
        updatedBranchId = branchRow.id;
      }
    }

    const updatedPhone = phone !== undefined ? (phone ? String(phone).trim() : null) : existing.phone;
    const updatedRole = role !== undefined ? String(role).trim() : existing.role;
    const updatedStatus = status !== undefined ? String(status).trim() : existing.status;
    const updatedPermissions = permissions !== undefined ? (Array.isArray(permissions) ? permissions : existing.permissions) : existing.permissions;

    const updated = await first(
      `UPDATE restaurant_users
       SET full_name = $1, email = $2, phone = $3, role = $4, branch_id = $5, status = $6, permissions = $7, updated_at = NOW()
       WHERE id = $8 AND restaurant_id = $9
       RETURNING *`,
      [updatedName, updatedEmail, updatedPhone, updatedRole, updatedBranchId, updatedStatus, JSON.stringify(updatedPermissions), id, partnerId]
    );

    return res.json({ success: true, data: updated, user: updated, message: 'User updated successfully.' });
  } catch (err: any) {
    console.error('Error updating restaurant user:', err);
    return res.status(500).json({ success: false, message: 'Unable to process request' });
  }
});

// DELETE /api/restaurant-users/:id
app.delete('/api/restaurant-users/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ success: false, message: 'Authentication required' });
  const { id } = req.params;

  try {
    const existing = await first('SELECT id FROM restaurant_users WHERE id = $1 AND restaurant_id = $2', [id, partnerId]);
    if (!existing) return res.status(404).json({ success: false, message: 'User not found' });
    await db.query('DELETE FROM restaurant_users WHERE id = $1 AND restaurant_id = $2', [id, partnerId]);
    return res.json({ success: true, message: 'User deleted successfully.', data: { id } });
  } catch (err: any) {
    console.error('Error deleting restaurant user:', err);
    return res.status(500).json({ success: false, message: 'Unable to process request' });
  }
});

app.patch('/api/restaurant-users', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = (req.query.id || req.body?.id) as string;
  if (!id) return res.status(400).json({ success: false, message: 'User ID is required' });
  req.params = { ...req.params, id };
  const layer = app._router.stack.find((r: any) => r.route?.path === '/api/restaurant-users/:id' && r.route?.methods?.patch);
  if (layer?.route) return layer.route.stack[layer.route.stack.length - 1].handle(req, res);
  return res.status(404).json({ success: false, message: 'User not found' });
});

app.delete('/api/restaurant-users', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = (req.query.id || req.body?.id) as string;
  if (!id) return res.status(400).json({ success: false, message: 'User ID is required' });
  req.params = { ...req.params, id };
  const layer = app._router.stack.find((r: any) => r.route?.path === '/api/restaurant-users/:id' && r.route?.methods?.delete);
  if (layer?.route) return layer.route.stack[layer.route.stack.length - 1].handle(req, res);
  return res.status(404).json({ success: false, message: 'User not found' });
});


// ============================================================
// BRANCHES (UNITS) MANAGEMENT API (100% TENANT ISOLATED)
// ============================================================

// GET /api/branches
app.get('/api/branches', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ success: false, message: 'Authentication required' });

  try {
    const branches = await db.query(
      'SELECT * FROM branches WHERE restaurant_id = $1 ORDER BY created_at DESC',
      [partnerId]
    );
    return res.json({
      success: true,
      data: branches.rows,
      branches: branches.rows,
      count: branches.rows.length,
    });
  } catch (err: any) {
    console.error('Error fetching branches:', err);
    return res.status(500).json({ success: false, message: 'Unable to process request' });
  }
});

// GET /api/branches/:id
app.get('/api/branches/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ success: false, message: 'Authentication required' });
  const { id } = req.params;

  try {
    const branch = await first('SELECT * FROM branches WHERE id = $1 AND restaurant_id = $2', [id, partnerId]);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });
    return res.json({ success: true, data: branch, branch });
  } catch (err: any) {
    console.error('Error fetching branch:', err);
    return res.status(500).json({ success: false, message: 'Unable to process request' });
  }
});

// POST /api/branches
app.post('/api/branches', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ success: false, message: 'Authentication required' });
  const { name, code, address, city, state, postal_code, phone, manager_name, status } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Branch name is required.', code: 'INVALID_NAME' });
  }

  try {
    const sub = await first(
      `SELECT s.*, p.max_branches, p.name AS plan_name
       FROM subscriptions s
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.partner_id = $1
       ORDER BY CASE
         WHEN s.status = 'active' THEN 1
         WHEN s.status = 'trial' THEN 2
         ELSE 3
       END,
       s.updated_at DESC NULLS LAST,
       s.created_at DESC
       LIMIT 1`,
      [partnerId]
    );
    const planName = (sub?.plan_name || sub?.plan || 'basic').toLowerCase();
    const defaultBranches = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : 2;
    const maxBranches = Number(sub?.max_branches ?? defaultBranches);

    const countRes = await db.query('SELECT COUNT(*) FROM branches WHERE restaurant_id = $1', [partnerId]);
    const currentBranches = parseInt(countRes.rows[0]?.count || '0', 10);

    if (maxBranches < 9999 && currentBranches >= maxBranches) {
      return res.status(403).json({
        success: false,
        message: `Your ${sub?.plan_name || 'current'} subscription plan allows up to ${maxBranches} units/branches. You have already created ${currentBranches} units. Please upgrade your plan to add more.`,
        code: 'MAX_BRANCHES_EXCEEDED',
        limit: maxBranches,
        current: currentBranches,
      });
    }

    const id = randomUUID();
    const branch = await first(
      `INSERT INTO branches (id, restaurant_id, name, code, address, city, state, postal_code, phone, manager_name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
       RETURNING *`,
      [
        id,
        partnerId,
        name.trim(),
        code ? String(code).trim() : null,
        address ? String(address).trim() : null,
        city ? String(city).trim() : null,
        state ? String(state).trim() : null,
        postal_code ? String(postal_code).trim() : null,
        phone ? String(phone).trim() : null,
        manager_name ? String(manager_name).trim() : null,
        status || 'active',
      ]
    );

    return res.status(201).json({ success: true, data: branch, branch, message: 'Branch created successfully.' });
  } catch (err: any) {
    console.error('Error creating branch:', err);
    return res.status(500).json({ success: false, message: 'Unable to process request' });
  }
});

// PATCH /api/branches/:id
app.patch('/api/branches/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ success: false, message: 'Authentication required' });
  const { id } = req.params;

  try {
    const existing = await first('SELECT * FROM branches WHERE id = $1 AND restaurant_id = $2', [id, partnerId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Branch not found' });

    const { name, code, address, city, state, postal_code, phone, manager_name, status } = req.body || {};

    const updatedName = name !== undefined ? String(name).trim() : existing.name;
    const updatedCode = code !== undefined ? (code ? String(code).trim() : null) : existing.code;
    const updatedAddress = address !== undefined ? (address ? String(address).trim() : null) : existing.address;
    const updatedCity = city !== undefined ? (city ? String(city).trim() : null) : existing.city;
    const updatedState = state !== undefined ? (state ? String(state).trim() : null) : existing.state;
    const updatedPostal = postal_code !== undefined ? (postal_code ? String(postal_code).trim() : null) : existing.postal_code;
    const updatedPhone = phone !== undefined ? (phone ? String(phone).trim() : null) : existing.phone;
    const updatedManager = manager_name !== undefined ? (manager_name ? String(manager_name).trim() : null) : existing.manager_name;
    const updatedStatus = status !== undefined ? String(status).trim() : existing.status;

    const updated = await first(
      `UPDATE branches
       SET name = $1, code = $2, address = $3, city = $4, state = $5, postal_code = $6, phone = $7, manager_name = $8, status = $9, updated_at = NOW()
       WHERE id = $10 AND restaurant_id = $11
       RETURNING *`,
      [updatedName, updatedCode, updatedAddress, updatedCity, updatedState, updatedPostal, updatedPhone, updatedManager, updatedStatus, id, partnerId]
    );

    return res.json({ success: true, data: updated, branch: updated, message: 'Branch updated successfully.' });
  } catch (err: any) {
    console.error('Error updating branch:', err);
    return res.status(500).json({ success: false, message: 'Unable to process request' });
  }
});

// DELETE /api/branches/:id
app.delete('/api/branches/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ success: false, message: 'Authentication required' });
  const { id } = req.params;

  try {
    const existing = await first('SELECT id FROM branches WHERE id = $1 AND restaurant_id = $2', [id, partnerId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Branch not found' });
    await db.query('DELETE FROM branches WHERE id = $1 AND restaurant_id = $2', [id, partnerId]);
    return res.json({ success: true, message: 'Branch deleted successfully.', data: { id } });
  } catch (err: any) {
    console.error('Error deleting branch:', err);
    return res.status(500).json({ success: false, message: 'Unable to process request' });
  }
});

app.patch('/api/branches', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = (req.query.id || req.body?.id) as string;
  if (!id) return res.status(400).json({ success: false, message: 'Branch ID is required' });
  req.params = { ...req.params, id };
  const layer = app._router.stack.find((r: any) => r.route?.path === '/api/branches/:id' && r.route?.methods?.patch);
  if (layer?.route) return layer.route.stack[layer.route.stack.length - 1].handle(req, res);
  return res.status(404).json({ success: false, message: 'Branch not found' });
});

app.delete('/api/branches', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = (req.query.id || req.body?.id) as string;
  if (!id) return res.status(400).json({ success: false, message: 'Branch ID is required' });
  req.params = { ...req.params, id };
  const layer = app._router.stack.find((r: any) => r.route?.path === '/api/branches/:id' && r.route?.methods?.delete);
  if (layer?.route) return layer.route.stack[layer.route.stack.length - 1].handle(req, res);
  return res.status(404).json({ success: false, message: 'Branch not found' });
});



// ============================================================
// SUPPLIERS MANAGEMENT API (100% TENANT ISOLATED)
// ============================================================

function isValidGSTIN(gst: string): boolean {
  if (!gst || typeof gst !== 'string') return false;
  const trimmed = gst.trim();
  if (trimmed.length !== 15) return false;
  const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;
  return gstRegex.test(trimmed);
}

function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

// GET /api/suppliers
app.get('/api/suppliers', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const offset = (page - 1) * limit;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    let whereClause = '(restaurant_id = $1 OR partner_id = $1)';
    const queryParams: any[] = [partnerId];

    if (search) {
      queryParams.push(`%${search}%`);
      whereClause += ` AND (
        name ILIKE $${queryParams.length} OR
        contact_person ILIKE $${queryParams.length} OR
        phone ILIKE $${queryParams.length} OR
        email ILIKE $${queryParams.length} OR
        gst_number ILIKE $${queryParams.length} OR
        city ILIKE $${queryParams.length} OR
        state ILIKE $${queryParams.length}
      )`;
    }

    const countRes = await db.query(
      `SELECT COUNT(*) FROM suppliers WHERE ${whereClause}`,
      queryParams
    );
    const totalCount = parseInt(countRes.rows[0]?.count || '0', 10);

    const dataParams = [...queryParams, limit, offset];
    const dataRes = await db.query(
      `SELECT * FROM suppliers WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    return res.json({
      success: true,
      data: dataRes.rows,
      suppliers: dataRes.rows,
      count: dataRes.rows.length,
      total: totalCount,
      page,
      limit,
    });
  } catch (err: any) {
    console.error('Error in GET /api/suppliers:', err);
    return res.status(500).json({ success: false, message: 'Unable to process supplier request' });
  }
});

// GET /api/suppliers/:id
app.get('/api/suppliers/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ success: false, message: 'Supplier ID is required' });
  }

  try {
    const supplier = await first(
      'SELECT * FROM suppliers WHERE id = $1 AND (restaurant_id = $2 OR partner_id = $2)',
      [id, partnerId]
    );

    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    return res.json({ success: true, data: supplier, supplier });
  } catch (err: any) {
    console.error('Error in GET /api/suppliers/:id:', err);
    return res.status(500).json({ success: false, message: 'Unable to process supplier request' });
  }
});

// POST /api/suppliers
app.post('/api/suppliers', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const {
    name,
    contact_person,
    phone,
    email,
    gst_number,
    payment_terms,
    address,
    city,
    state,
    postal_code,
    status,
  } = req.body || {};

  // 1. Validate Name
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Supplier name is required' });
  }
  const trimmedName = name.trim();
  if (trimmedName.length > 255) {
    return res.status(400).json({ success: false, message: 'Supplier name cannot exceed 255 characters' });
  }

  // 2. Validate Email
  let normalizedEmail: string | null = null;
  if (email && typeof email === 'string' && email.trim()) {
    const trimmedEmail = email.trim();
    if (!isValidEmail(trimmedEmail) || trimmedEmail.length > 255) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }
    normalizedEmail = trimmedEmail.toLowerCase();
  }

  // 3. Validate Phone
  let normalizedPhone: string | null = null;
  if (phone && typeof phone === 'string' && phone.trim()) {
    const trimmedPhone = phone.trim();
    if (trimmedPhone.length > 30) {
      return res.status(400).json({ success: false, message: 'Phone number cannot exceed 30 characters' });
    }
    normalizedPhone = trimmedPhone;
  }

  // 4. Validate GSTIN (15-character standard format)
  let normalizedGST: string | null = null;
  if (gst_number && typeof gst_number === 'string' && gst_number.trim()) {
    const trimmedGST = gst_number.trim();
    if (!isValidGSTIN(trimmedGST)) {
      return res.status(400).json({ success: false, message: 'Invalid GST number' });
    }
    normalizedGST = trimmedGST.toUpperCase();
  }

  // 5. Validate Payment Terms
  let normalizedPaymentTerms = 'Net 30';
  if (payment_terms && typeof payment_terms === 'string' && payment_terms.trim()) {
    const trimmedPT = payment_terms.trim();
    if (trimmedPT.length > 100) {
      return res.status(400).json({ success: false, message: 'Payment terms cannot exceed 100 characters' });
    }
    normalizedPaymentTerms = trimmedPT;
  }

  const normalizedContactPerson = contact_person && typeof contact_person === 'string' && contact_person.trim() ? contact_person.trim().slice(0, 255) : null;
  const normalizedAddress = address && typeof address === 'string' && address.trim() ? address.trim() : null;
  const normalizedCity = city && typeof city === 'string' && city.trim() ? city.trim().slice(0, 100) : null;
  const normalizedState = state && typeof state === 'string' && state.trim() ? state.trim().slice(0, 100) : null;
  const normalizedPostalCode = postal_code && typeof postal_code === 'string' && postal_code.trim() ? postal_code.trim().slice(0, 20) : null;
  const supplierStatus = status === 'inactive' ? 'inactive' : 'active';

  try {
    // 6. Check duplicate name within same tenant
    const existing = await first(
      'SELECT id FROM suppliers WHERE (restaurant_id = $1 OR partner_id = $1) AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
      [partnerId, trimmedName]
    );
    if (existing) {
      return res.status(409).json({ success: false, message: 'Supplier already exists' });
    }

    const id = randomUUID();
    const supplier = await first(
      `INSERT INTO suppliers (
        id, restaurant_id, partner_id, name, contact_person, phone, email,
        gst_number, payment_terms, address, city, state, postal_code,
        outstanding_amount, status, created_at, updated_at
      ) VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, NOW(), NOW())
      RETURNING *`,
      [
        id,
        partnerId,
        trimmedName,
        normalizedContactPerson,
        normalizedPhone,
        normalizedEmail,
        normalizedGST,
        normalizedPaymentTerms,
        normalizedAddress,
        normalizedCity,
        normalizedState,
        normalizedPostalCode,
        supplierStatus,
      ]
    );

    return res.status(201).json({
      success: true,
      data: supplier,
      supplier,
      message: 'Supplier added successfully.',
    });
  } catch (err: any) {
    console.error('Error in POST /api/suppliers:', err);
    return res.status(500).json({ success: false, message: 'Unable to process supplier request' });
  }
});

// PATCH /api/suppliers/:id
app.patch('/api/suppliers/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ success: false, message: 'Supplier ID is required' });
  }

  try {
    const existing = await first(
      'SELECT * FROM suppliers WHERE id = $1 AND (restaurant_id = $2 OR partner_id = $2)',
      [id, partnerId]
    );
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    const {
      name,
      contact_person,
      phone,
      email,
      gst_number,
      payment_terms,
      address,
      city,
      state,
      postal_code,
      status,
      outstanding_amount,
    } = req.body || {};

    let updatedName = existing.name;
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Supplier name cannot be empty' });
      }
      const trimmed = name.trim();
      if (trimmed.length > 255) {
        return res.status(400).json({ success: false, message: 'Supplier name cannot exceed 255 characters' });
      }

      // Check duplicate name within same tenant if name changed
      if (trimmed.toLowerCase() !== existing.name.toLowerCase()) {
        const dup = await first(
          'SELECT id FROM suppliers WHERE (restaurant_id = $1 OR partner_id = $1) AND LOWER(TRIM(name)) = LOWER($2) AND id != $3 LIMIT 1',
          [partnerId, trimmed, id]
        );
        if (dup) {
          return res.status(409).json({ success: false, message: 'Supplier already exists' });
        }
      }
      updatedName = trimmed;
    }

    let updatedEmail = existing.email;
    if (email !== undefined) {
      if (email && typeof email === 'string' && email.trim()) {
        const trimmedEmail = email.trim();
        if (!isValidEmail(trimmedEmail) || trimmedEmail.length > 255) {
          return res.status(400).json({ success: false, message: 'Invalid email address' });
        }
        updatedEmail = trimmedEmail.toLowerCase();
      } else {
        updatedEmail = null;
      }
    }

    let updatedPhone = existing.phone;
    if (phone !== undefined) {
      if (phone && typeof phone === 'string' && phone.trim()) {
        const trimmedPhone = phone.trim();
        if (trimmedPhone.length > 30) {
          return res.status(400).json({ success: false, message: 'Phone number cannot exceed 30 characters' });
        }
        updatedPhone = trimmedPhone;
      } else {
        updatedPhone = null;
      }
    }

    let updatedGST = existing.gst_number;
    if (gst_number !== undefined) {
      if (gst_number && typeof gst_number === 'string' && gst_number.trim()) {
        const trimmedGST = gst_number.trim();
        if (!isValidGSTIN(trimmedGST)) {
          return res.status(400).json({ success: false, message: 'Invalid GST number' });
        }
        updatedGST = trimmedGST.toUpperCase();
      } else {
        updatedGST = null;
      }
    }

    let updatedPT = existing.payment_terms;
    if (payment_terms !== undefined) {
      if (payment_terms && typeof payment_terms === 'string' && payment_terms.trim()) {
        const trimmedPT = payment_terms.trim();
        if (trimmedPT.length > 100) {
          return res.status(400).json({ success: false, message: 'Payment terms cannot exceed 100 characters' });
        }
        updatedPT = trimmedPT;
      } else {
        updatedPT = 'Net 30';
      }
    }

    const updatedContactPerson = contact_person !== undefined
      ? (contact_person && typeof contact_person === 'string' && contact_person.trim() ? contact_person.trim().slice(0, 255) : null)
      : existing.contact_person;

    const updatedAddress = address !== undefined
      ? (address && typeof address === 'string' && address.trim() ? address.trim() : null)
      : existing.address;

    const updatedCity = city !== undefined
      ? (city && typeof city === 'string' && city.trim() ? city.trim().slice(0, 100) : null)
      : existing.city;

    const updatedState = state !== undefined
      ? (state && typeof state === 'string' && state.trim() ? state.trim().slice(0, 100) : null)
      : existing.state;

    const updatedPostalCode = postal_code !== undefined
      ? (postal_code && typeof postal_code === 'string' && postal_code.trim() ? postal_code.trim().slice(0, 20) : null)
      : existing.postal_code;

    const updatedStatus = status !== undefined
      ? (status === 'inactive' ? 'inactive' : 'active')
      : existing.status;

    const updatedOutstanding = outstanding_amount !== undefined && !isNaN(Number(outstanding_amount))
      ? Number(outstanding_amount)
      : existing.outstanding_amount;

    const updated = await first(
      `UPDATE suppliers
       SET name = $1,
           contact_person = $2,
           phone = $3,
           email = $4,
           gst_number = $5,
           payment_terms = $6,
           address = $7,
           city = $8,
           state = $9,
           postal_code = $10,
           status = $11,
           outstanding_amount = $12,
           partner_id = $13,
           updated_at = NOW()
       WHERE id = $14 AND (restaurant_id = $13 OR partner_id = $13)
       RETURNING *`,
      [
        updatedName,
        updatedContactPerson,
        updatedPhone,
        updatedEmail,
        updatedGST,
        updatedPT,
        updatedAddress,
        updatedCity,
        updatedState,
        updatedPostalCode,
        updatedStatus,
        updatedOutstanding,
        partnerId,
        id,
      ]
    );

    return res.json({
      success: true,
      data: updated,
      supplier: updated,
      message: 'Supplier updated successfully.',
    });
  } catch (err: any) {
    console.error('Error in PATCH /api/suppliers/:id:', err);
    return res.status(500).json({ success: false, message: 'Unable to process supplier request' });
  }
});

// DELETE /api/suppliers/:id
app.delete('/api/suppliers/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ success: false, message: 'Supplier ID is required' });
  }

  try {
    const existing = await first(
      'SELECT id, name FROM suppliers WHERE id = $1 AND (restaurant_id = $2 OR partner_id = $2)',
      [id, partnerId]
    );
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    // Check FK references before deleting
    const [invCount, poCount, srCount, prCount] = await Promise.all([
      db.query('SELECT COUNT(*) FROM inventory_items WHERE supplier_id = $1', [id]),
      db.query('SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = $1', [id]),
      db.query('SELECT COUNT(*) FROM stock_receipts WHERE supplier_id = $1', [id]),
      db.query('SELECT COUNT(*) FROM purchase_returns WHERE supplier_id = $1', [id]),
    ]);

    const totalRefs =
      parseInt(invCount.rows[0]?.count || '0', 10) +
      parseInt(poCount.rows[0]?.count || '0', 10) +
      parseInt(srCount.rows[0]?.count || '0', 10) +
      parseInt(prCount.rows[0]?.count || '0', 10);

    if (totalRefs > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete supplier because it is referenced in inventory items or purchase records. You can update its status to inactive instead.',
      });
    }

    await db.query('DELETE FROM suppliers WHERE id = $1 AND (restaurant_id = $2 OR partner_id = $2)', [id, partnerId]);

    return res.json({
      success: true,
      message: 'Supplier deleted successfully.',
      data: { id },
    });
  } catch (err: any) {
    console.error('Error in DELETE /api/suppliers/:id:', err);
    return res.status(500).json({ success: false, message: 'Unable to process supplier request' });
  }
});



initDatabase().then(() => {
	app.listen(config.port, () => console.log(`BhojMitra backend listening on http://localhost:${config.port}`));
}).catch((error) => {
	console.error('Unable to initialize PostgreSQL:', error);
	process.exit(1);
});
