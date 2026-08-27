import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { db, initDatabase } from './db.js';
import { requireAuth, requireCompletedOnboarding } from './middleware/auth.js';
import type { AuthenticatedRequest } from './types.js';
import { demoRequestSchema, ticketSchema } from './validation.js';
import { referenceId } from './utils.js';

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));
const tokenFor = (id: string) => jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: '7d' });
const first = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0];

app.get('/health', async (_req, res) => { try { await db.query('SELECT 1'); res.json({ status: 'ok', database: 'postgresql' }); } catch { res.status(503).json({ status: 'error' }); } });
app.post('/api/auth/register', async (req, res) => { const { owner_name, restaurant_name, email, phone, password } = req.body; if (![owner_name, restaurant_name, email, phone, password].every((v) => typeof v === 'string' && v.trim()) || password.length < 6) return res.status(400).json({ error: 'Valid registration fields are required.' }); try { const id = randomUUID(); const client = await db.connect(); try { await client.query('BEGIN'); await client.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [id, email.trim().toLowerCase(), await bcrypt.hash(password, 12)]); await client.query('INSERT INTO partners (id,owner_name,restaurant_name,email,phone) VALUES ($1,$2,$3,$4,$5)', [id, owner_name.trim(), restaurant_name.trim(), email.trim().toLowerCase(), phone.trim()]); await client.query('INSERT INTO subscriptions (id,partner_id) VALUES ($1,$2)', [randomUUID(), id]); await client.query('COMMIT'); return res.status(201).json({ token: tokenFor(id), user: { id, email: email.trim().toLowerCase() } }); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } } catch { return res.status(409).json({ error: 'An account with this email already exists.' }); } });
app.post('/api/auth/login', async (req, res) => { const user = await first('SELECT id,email,password_hash FROM users WHERE email=$1', [String(req.body.email || '').trim().toLowerCase()]); if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) return res.status(401).json({ error: 'Invalid email or password.' }); return res.json({ token: tokenFor(user.id), user: { id: user.id, email: user.email } }); });
app.post('/api/demo-requests', async (req, res) => { const parsed = demoRequestSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Invalid demo request.' }); const ref = referenceId('DMO'); const d = parsed.data; const request = await first('INSERT INTO demo_requests (id,name,restaurant_name,email,phone,city,number_of_branches,preferred_date,preferred_time,message,reference_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [randomUUID(), d.name,d.restaurant_name,d.email,d.phone,d.city,d.number_of_branches,d.preferred_date,d.preferred_time,d.message,ref]); return res.status(201).json({ request, reference_id: ref }); });
app.post('/api/contact-queries', async (req, res) => { const { name,email,phone,subject,message } = req.body; if (![name,email,phone,subject,message].every((v) => typeof v === 'string' && v.trim())) return res.status(400).json({ error: 'All contact fields are required.' }); const query = await first('INSERT INTO contact_queries (id,name,email,phone,subject,message,reference_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [randomUUID(),name,email,phone,subject,message,referenceId('QRY')]); return res.status(201).json({ query }); });
app.use('/api', requireAuth);

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

app.get('/api/subscriptions/plans', async (_req, res) => {
  try {
    const plans = await db.query('SELECT id,name,price,billing_cycle,max_users,max_branches,trial_days,features,is_active FROM subscription_plans WHERE is_active=TRUE ORDER BY price ASC');
    res.json({ success: true, plans: plans.rows });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch subscription plans' });
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

app.post('/api/subscriptions', async (req: AuthenticatedRequest, res) => {
  try {
    const planId = Number(req.body.planId);
    if (!Number.isInteger(planId)) return res.status(400).json({ success: false, message: 'planId is required' });
    const plan = await first('SELECT * FROM subscription_plans WHERE id=$1 AND is_active=TRUE', [planId]);
    if (!plan) return res.status(404).json({ success: false, message: 'Subscription plan not found' });
    const existing = await first("SELECT id FROM subscriptions WHERE partner_id=$1 AND status='active'", [req.userId]);
    if (existing) return res.status(409).json({ success: false, message: 'User already has an active subscription' });
    const startDate = new Date();
    const expiryDate = new Date(startDate);
    if (plan.trial_days > 0) expiryDate.setDate(expiryDate.getDate() + plan.trial_days);
    else expiryDate.setMonth(expiryDate.getMonth() + 1);
    const subscription = await first('INSERT INTO subscriptions (id,partner_id,plan_id,plan,billing_cycle,status,start_date,expiry_date,auto_renew,amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9) RETURNING *', [randomUUID(), req.userId, plan.id, String(plan.name).toLowerCase(), plan.billing_cycle, 'active', startDate, expiryDate, plan.price]);
    res.status(201).json({ success: true, message: 'Subscription created successfully', subscription });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to create subscription' });
  }
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

app.get('/api/me', async (req: AuthenticatedRequest, res) => {
  try {
    const partner = await first(
      'SELECT * FROM partners WHERE id=$1',
      [req.userId]
    );

    const subscription = await first(
      'SELECT * FROM subscriptions WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 1',
      [req.userId]
    );

    return res.json({
      partner,
      subscription,
    });
  } catch (error) {
    console.error('GET /api/me error:', error);
    return res.status(500).json({
      error: 'Failed to fetch user profile.',
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
app.post('/api/onboarding/complete', async (req: AuthenticatedRequest, res) => {
  const { owner_name, phone, restaurant_name, restaurant_type, city, business_name, gst_number, business_type, branch_count, branch_city } = req.body;
  const required = { owner_name, phone, restaurant_name, restaurant_type, city, business_name, gst_number, business_type, branch_city };
  if (Object.values(required).some((value) => typeof value !== 'string' || !value.trim()) || !Number.isInteger(Number(branch_count)) || Number(branch_count) < 1) {
    return res.status(400).json({ error: 'Complete all required onboarding details before continuing.' });
  }
  try {
    const subscription = await first('SELECT status FROM subscriptions WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 1', [req.userId]);
    const status = subscription?.status === 'active' ? 'active' : 'trial';
    const partner = await first('UPDATE partners SET owner_name=$1,phone=$2,restaurant_name=$3,restaurant_type=$4,city=$5,business_name=$6,gst_number=$7,business_type=$8,number_of_branches=$9,status=$10,onboarding_completed=TRUE,updated_at=NOW() WHERE id=$11 RETURNING *', [owner_name.trim(), phone.trim(), restaurant_name.trim(), restaurant_type.trim(), city.trim(), business_name.trim(), gst_number.trim(), business_type.trim(), Number(branch_count), status, req.userId]);
    if (!partner) return res.status(404).json({ error: 'Restaurant account not found.' });
    return res.json({ partner, onboarding_completed: true });
  } catch {
    return res.status(500).json({ error: 'Unable to complete onboarding. Please try again.' });
  }
});
app.get('/api/dashboard', async (req: AuthenticatedRequest,res) => { const id=req.userId; const [partner,subscription,invoices,tickets,notifications]=await Promise.all([first('SELECT * FROM partners WHERE id=$1',[id]),first('SELECT * FROM subscriptions WHERE partner_id=$1',[id]),db.query('SELECT * FROM invoices WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 5',[id]),db.query('SELECT * FROM support_tickets WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 5',[id]),db.query('SELECT * FROM notifications WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 5',[id])]); res.json({partner,subscription,invoices:invoices.rows,tickets:tickets.rows,notifications:notifications.rows}); });
app.get('/api/subscription',async(req:AuthenticatedRequest,res)=>res.json({subscription:await first('SELECT * FROM subscriptions WHERE partner_id=$1',[req.userId])}));
app.patch('/api/subscription',async(req:AuthenticatedRequest,res)=>{const allowed=['plan_id','plan','billing_cycle','status','auto_renew','amount','start_date','expiry_date']; for(const [key,value] of Object.entries(req.body).filter(([k])=>allowed.includes(k))) await db.query(`UPDATE subscriptions SET ${key}=$1,updated_at=NOW() WHERE partner_id=$2`,[value,req.userId]); res.json({subscription:await first('SELECT * FROM subscriptions WHERE partner_id=$1 ORDER BY created_at DESC LIMIT 1',[req.userId])});});
app.get('/api/invoices',async(req:AuthenticatedRequest,res)=>res.json({invoices:(await db.query('SELECT * FROM invoices WHERE partner_id=$1 ORDER BY created_at DESC',[req.userId])).rows}));
app.get('/api/notifications',async(req:AuthenticatedRequest,res)=>res.json({notifications:(await db.query('SELECT * FROM notifications WHERE partner_id=$1 ORDER BY created_at DESC',[req.userId])).rows}));
app.patch('/api/notifications/:id/read',async(req:AuthenticatedRequest,res)=>{await db.query('UPDATE notifications SET is_read=TRUE WHERE id=$1 AND partner_id=$2',[req.params.id,req.userId]);res.json({ok:true});});
app.delete('/api/notifications/:id',async(req:AuthenticatedRequest,res)=>{await db.query('DELETE FROM notifications WHERE id=$1 AND partner_id=$2',[req.params.id,req.userId]);res.status(204).send();});
app.get('/api/documents',async(req:AuthenticatedRequest,res)=>res.json({documents:(await db.query('SELECT * FROM documents WHERE partner_id=$1 ORDER BY created_at DESC',[req.userId])).rows}));
app.post('/api/documents',async(req:AuthenticatedRequest,res)=>{const {file_name,file_type,document_type}=req.body;if(!file_name||!document_type)return res.status(400).json({error:'file_name and document_type are required.'});const document=await first('INSERT INTO documents (id,partner_id,file_name,file_type,document_type) VALUES ($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),req.userId,file_name,file_type,document_type]);res.status(201).json({document});});
app.delete('/api/documents/:id',async(req:AuthenticatedRequest,res)=>{await db.query('DELETE FROM documents WHERE id=$1 AND partner_id=$2',[req.params.id,req.userId]);res.status(204).send();});
app.get('/api/support/tickets',async(req:AuthenticatedRequest,res)=>res.json({tickets:(await db.query('SELECT * FROM support_tickets WHERE partner_id=$1 ORDER BY created_at DESC',[req.userId])).rows}));
app.post('/api/support/tickets',async(req:AuthenticatedRequest,res)=>{const parsed=ticketSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid ticket.'});const t=parsed.data;const ticket=await first('INSERT INTO support_tickets (id,partner_id,ticket_number,subject,category,priority,message) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),req.userId,referenceId('TKT'),t.subject,t.category,t.priority,t.message]);res.status(201).json({ticket});});
initDatabase().then(() => {
	app.listen(config.port, () => console.log(`BhojMitra backend listening on http://localhost:${config.port}`));
}).catch((error) => {
	console.error('Unable to initialize PostgreSQL:', error);
	process.exit(1);
});
