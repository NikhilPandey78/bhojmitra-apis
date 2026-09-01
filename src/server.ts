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
         ORDER BY s.created_at DESC
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

    const subscriptionPlan = (sub?.plan_name || sub?.plan || 'trial').toLowerCase();
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
            plan: (sub.plan_name || sub.plan || 'trial').toLowerCase(),
            status: sub.status || 'trial',
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
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [payload.sub]
    );

    const subscriptionPlan = (sub?.plan_name || sub?.plan || 'trial').toLowerCase();
    const defaultBranches = subscriptionPlan === 'pro' ? 9999 : subscriptionPlan === 'basic' ? 5 : subscriptionPlan === 'starter' ? 3 : 2;
    const defaultUsers = subscriptionPlan === 'pro' ? 9999 : subscriptionPlan === 'basic' ? 5 : subscriptionPlan === 'starter' ? 3 : 2;

    const subscriptionObj = sub
      ? {
          id: sub.id,
          restaurant_id: partner.id,
          plan: (sub.plan_name || sub.plan || 'trial').toLowerCase(),
          status: sub.status || 'trial',
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

  if (!partner.onboarding_completed && partner.restaurant_name) {
    await db.query("UPDATE partners SET onboarding_completed = TRUE, onboarding_status = 'completed', updated_at = NOW() WHERE id = $1", [req.userId]);
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

  const ssoUrl = `${config.myRestoUrl.replace(/\/$/, '')}/sso/callback?code=${rawCode}`;
  return res.json({
    success: true,
    sso_url: ssoUrl,
    code: rawCode,
    expires_in: 60,
  });
});

const subscriptionSelect = `
  SELECT s.id, s.partner_id AS user_id, s.start_date, s.expiry_date, s.auto_renew, s.status,
    p.id AS plan_id, p.name AS plan_name, p.price, p.billing_cycle, p.max_users, p.max_branches, p.features
  FROM subscriptions s
  JOIN subscription_plans p ON p.id = s.plan_id
  WHERE s.partner_id = $1
  ORDER BY s.created_at DESC
  LIMIT 1`;

const subscriptionResponse = (subscription: any) => {
  const daysRemaining = subscription.expiry_date
    ? Math.max(0, Math.ceil((new Date(subscription.expiry_date).getTime() - Date.now()) / 86_400_000))
    : 0;
  return {
    id: subscription.id,
    plan: subscription.plan_name,
    price: Number(subscription.price),
    billingCycle: subscription.billing_cycle,
    startDate: subscription.start_date,
    expiryDate: subscription.expiry_date,
    daysRemaining,
    autoRenew: subscription.auto_renew,
    status: subscription.status,
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
       JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.partner_id=$1
       ORDER BY s.created_at DESC
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
       ORDER BY s.created_at DESC
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
     ORDER BY s.created_at DESC
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
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [partnerId]
    );
    if (!sub) return res.json({ data: [] });
    const planName = (sub.plan_name || sub.plan || 'trial').toLowerCase();
    const defaultBranches = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : 2;
    const defaultUsers = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : 2;
    const mappedSub = {
      id: sub.id,
      restaurant_id: partnerId,
      plan: planName,
      status: sub.status || 'trial',
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

  const items = Array.isArray(req.body) ? req.body : [req.body];
  const inserted: any[] = [];

  for (const rawItem of items) {
    const item = { ...rawItem };
    const id = item.id || randomUUID();
    item.id = id;
    if (table !== 'partners' && table !== 'restaurants') {
      item.restaurant_id = partnerId;
    }

    const keys = Object.keys(item).filter(k => k !== 'category' && k !== 'unit' && k !== 'supplier' && k !== 'item' && k !== 'from_unit' && k !== 'to_unit' && k !== 'items');
    const cols = keys.map(k => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const vals = keys.map(k => item[k]);

    const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${keys.map(k => `"${k}" = EXCLUDED."${k}"`).join(', ')} RETURNING *`;
    const row = await first(sql, vals);
    inserted.push(row);
  }

  return res.status(201).json({ data: Array.isArray(req.body) ? inserted : inserted[0] });
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

  const keys = Object.keys(item);
  if (keys.length === 0) return res.json({ data: null });

  const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
  const vals = keys.map(k => item[k]);
  vals.push(id);
  vals.push(partnerId);

  const sql = `UPDATE ${table} SET ${setClauses} WHERE id = $${vals.length - 1} AND restaurant_id = $${vals.length} RETURNING *`;
  const updated = await first(sql, vals);
  return res.json({ data: updated });
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

  await db.query(`DELETE FROM ${table} WHERE id = $1 AND restaurant_id = $2`, [id, partnerId]);
  return res.status(200).json({ success: true });
});

initDatabase().then(() => {
	app.listen(config.port, () => console.log(`BhojMitra backend listening on http://localhost:${config.port}`));
}).catch((error) => {
	console.error('Unable to initialize PostgreSQL:', error);
	process.exit(1);
});
