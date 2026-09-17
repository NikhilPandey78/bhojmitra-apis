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
  'http://localhost:5174',
  'http://localhost:5175',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
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
const formatCurrency = (n: number | string) => Number(n || 0).toFixed(2);

const razorpay = new Razorpay({
  key_id: config.razorpayKeyId,
  key_secret: config.razorpayKeySecret,
});

const ONBOARDING_STATUSES = ['pending', 'in_progress', 'completed'] as const;
const ACCESSIBLE_SUBSCRIPTION_STATUSES = new Set(['trial', 'active']);

async function syncPlanLimits() {
  try {
    await db.query(`
      UPDATE subscription_plans
      SET max_branches = 1, max_users = 2, features = $1
      WHERE id = 1 OR LOWER(name) LIKE '%trial%'
    `, [JSON.stringify(['Full feature access', '14-day trial', 'Up to 2 team members', '1 branch'])]);
  } catch (err) {
    console.error('syncPlanLimits error:', err);
  }
}
syncPlanLimits();

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

async function logAdminActivity(
  restaurantId: string | null,
  userId: string | null,
  userName: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  description: string,
  ipAddress?: string
) {
  try {
    const id = randomUUID();
    await db.query(
      `INSERT INTO activity_logs (id, restaurant_id, user_id, user_name, action, entity_type, entity_id, description, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [id, restaurantId, userId, userName, action, entityType, entityId, description, ipAddress || '127.0.0.1']
    );
  } catch (err) {
    console.error('Error recording activity log:', err);
  }
}

const logActivity = logAdminActivity;

app.get(['/health', '/api/health'], async (_req, res) => { try { await db.query('SELECT 1'); res.json({ status: 'ok', database: 'postgresql' }); } catch { res.status(503).json({ status: 'error' }); } });
app.post('/api/auth/register', async (req, res) => {
  const owner_name = req.body?.owner_name || req.body?.fullName || req.body?.ownerName;
  const restaurant_name = req.body?.restaurant_name || req.body?.restaurantName;
  const email = req.body?.email;
  const phone = req.body?.phone;
  const password = req.body?.password;

  if (
    !owner_name || typeof owner_name !== 'string' || !owner_name.trim() ||
    !restaurant_name || typeof restaurant_name !== 'string' || !restaurant_name.trim() ||
    !email || typeof email !== 'string' || !email.trim() || !email.includes('@') ||
    !password || typeof password !== 'string' || password.length < 6
  ) {
    return res.status(400).json({ error: 'Full name, restaurant name, valid email, and password (min 6 characters) are required.' });
  }
  try {
    const id = randomUUID();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const emailLower = email.trim().toLowerCase();
      const ownerNameTrimmed = owner_name.trim();
      const restoNameTrimmed = restaurant_name.trim();
      const phoneTrimmed = phone ? phone.trim() : null;

      // 1. Create auth user
      await client.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [id, emailLower, await bcrypt.hash(password, 12)]);
      
      // 2. Create partner (restaurant / business profile)
      const businessType = String(req.body.business_type || 'restaurant').toLowerCase().trim();
      await client.query(
        `INSERT INTO partners
         (id,owner_name,restaurant_name,email,phone,business_type,onboarding_status,onboarding_completed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE)`,
        [id, ownerNameTrimmed, restoNameTrimmed, emailLower, phoneTrimmed, businessType, 'pending']
      );

      // 3. Create default Main Branch for this restaurant
      const mainBranchId = randomUUID();
      await client.query(
        `INSERT INTO branches (id, restaurant_id, name, code, address, city, status)
         VALUES ($1, $2, 'Main Branch', 'MAIN', '', '', 'active')`,
        [mainBranchId, id]
      );

      // 4. Create Owner entry in restaurant_users with full permissions
      await client.query(
        `INSERT INTO restaurant_users (id, restaurant_id, auth_user_id, full_name, email, phone, role, status, permissions, branch_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'owner', 'active', $7, $8)`,
        [id, id, id, ownerNameTrimmed, emailLower, phoneTrimmed, JSON.stringify(['*']), mainBranchId]
      );

      // 5. Seed standard isolated units of measure for this tenant
      const defaultUnits = [
        { name: 'Kilogram', symbol: 'kg', factor: 1 },
        { name: 'Gram', symbol: 'g', factor: 0.001 },
        { name: 'Liter', symbol: 'L', factor: 1 },
        { name: 'Milliliter', symbol: 'ml', factor: 0.001 },
        { name: 'Pieces', symbol: 'pcs', factor: 1 },
        { name: 'Box', symbol: 'box', factor: 1 },
        { name: 'Packet', symbol: 'pkt', factor: 1 },
        { name: 'Dozen', symbol: 'dz', factor: 12 },
        { name: 'Can', symbol: 'can', factor: 1 },
        { name: 'Bottle', symbol: 'btl', factor: 1 },
      ];
      for (const u of defaultUnits) {
        await client.query(
          `INSERT INTO units (id, restaurant_id, name, symbol, conversion_factor)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), id, u.name, u.symbol, u.factor]
        );
      }

      // 6. Seed industry-tailored categories based on selected business_type
      const verticalCategoriesMap: Record<string, { name: string; color: string; description: string }[]> = {
        hotel: [
          { name: 'Housekeeping Supplies', color: '#3b82f6', description: 'Cleaning chemicals, mops, sanitizers, and detergents' },
          { name: 'Room Amenities', color: '#10b981', description: 'Toiletries, dental kits, slippers, and bottled water' },
          { name: 'Linen & Laundry', color: '#6366f1', description: 'Bedsheets, pillow covers, bath towels, and bathrobes' },
          { name: 'Food & Beverage Raw', color: '#f59e0b', description: 'Kitchen supplies, pantry goods, and bar consumables' },
          { name: 'Banquet & Event Supplies', color: '#ec4899', description: 'Table decorations, cutlery, chafing dishes, and linens' },
          { name: 'Maintenance & Engineering', color: '#64748b', description: 'Bulbs, plumbing spares, HVAC filters, and hardware' },
        ],
        hospital: [
          { name: 'Pharmacy & Medicines', color: '#ef4444', description: 'Tablets, syrups, antibiotics, and prescription drugs' },
          { name: 'Surgical Consumables', color: '#06b6d4', description: 'Gloves, syringes, gauze, sutures, and surgical drapes' },
          { name: 'ICU & OT Supplies', color: '#dc2626', description: 'Critical care consumables, anesthesia agents, and tubes' },
          { name: 'Diagnostic & Lab Reagents', color: '#8b5cf6', description: 'Blood tubes, testing strips, reagents, and chemicals' },
          { name: 'Patient Care & Linen', color: '#10b981', description: 'Hospital bedsheets, patient gowns, and pillows' },
          { name: 'General Medical Store', color: '#64748b', description: 'Sanitizers, masks, aprons, and general hospital supplies' },
        ],
        grocery: [
          { name: 'Packaged Food & Grains', color: '#f59e0b', description: 'Rice, wheat flour, pulses, cooking oils, and noodles' },
          { name: 'Snacks & Confectionery', color: '#ec4899', description: 'Biscuits, chips, chocolates, and namkeen' },
          { name: 'Dairy & Beverages', color: '#06b6d4', description: 'Milk, cheese, butter, cold drinks, and juices' },
          { name: 'Personal Care & Hygiene', color: '#10b981', description: 'Soaps, shampoos, toothpaste, and skin creams' },
          { name: 'Household & Cleaning', color: '#3b82f6', description: 'Detergents, floor cleaners, dishwashers, and trash bags' },
        ],
        sweet_shop: [
          { name: 'Milk & Mawa Solids', color: '#f59e0b', description: 'Pure milk, khoya, mawa, paneer, and condensed milk' },
          { name: 'Sugar & Sweeteners', color: '#64748b', description: 'Refined sugar, jaggery, glucose syrup, and honey' },
          { name: 'Dry Fruits & Nuts', color: '#8b5cf6', description: 'Almonds, cashews, pistachios, saffron, and raisins' },
          { name: 'Pure Ghee & Edible Oils', color: '#eab308', description: 'Desi cow ghee, vanaspati, and frying oils' },
          { name: 'Packaging Sweet Boxes', color: '#ec4899', description: 'Designer sweet boxes, gift hampers, and carry bags' },
        ],
        bakery: [
          { name: 'Flours & Grain Mixes', color: '#f59e0b', description: 'Maida, whole wheat, cake pre-mixes, and yeast' },
          { name: 'Butter, Fats & Chocolates', color: '#8b5cf6', description: 'Unsalted butter, margarine, dark compound, and cocoa' },
          { name: 'Essences, Colors & Pastes', color: '#ec4899', description: 'Vanilla extract, food dyes, fruit emulsions, and gels' },
          { name: 'Cake Toppings & Fondants', color: '#06b6d4', description: 'Whipping cream, sprinkles, fondant icing, and glazes' },
          { name: 'Bakery Packaging', color: '#64748b', description: 'Cake boxes, pastry trays, bread pouches, and ribbons' },
        ],
        cafe: [
          { name: 'Coffee Beans & Roasts', color: '#8b5cf6', description: 'Espresso blends, Arabica beans, and instant coffee' },
          { name: 'Syrups & Flavors', color: '#f59e0b', description: 'Caramel, vanilla, hazelnut, and fruit puree' },
          { name: 'Milk & Dairy Alternatives', color: '#06b6d4', description: 'Fresh milk, oat milk, almond milk, and whipped cream' },
          { name: 'Bakery & Quick Bites', color: '#ec4899', description: 'Croissants, muffins, cookies, and sandwiches' },
          { name: 'Cups, Straws & Packaging', color: '#64748b', description: 'Paper cups, cup sleeves, bio-straws, and takeaway bags' },
        ],
        retail: [
          { name: 'Apparel & Clothing', color: '#3b82f6', description: 'Shirts, t-shirts, trousers, ethnic wear, and dresses' },
          { name: 'Footwear & Shoes', color: '#f59e0b', description: 'Casual shoes, formal footwear, sandals, and socks' },
          { name: 'Accessories & Bags', color: '#ec4899', description: 'Belts, wallets, handbags, watches, and jewelry' },
          { name: 'Electronics & Gadgets', color: '#06b6d4', description: 'Chargers, cables, headphones, power banks, and cases' },
          { name: 'Cosmetics & Beauty', color: '#8b5cf6', description: 'Skincare, perfumes, makeup, and grooming products' },
        ],
        restaurant: [
          { name: 'Vegetables & Produce', color: '#10b981', description: 'Fresh vegetables, fruits, and raw produce' },
          { name: 'Meat & Poultry', color: '#ef4444', description: 'Chicken, mutton, seafood, and meat products' },
          { name: 'Dairy & Cheese', color: '#f59e0b', description: 'Milk, cheese, butter, cream, and paneer' },
          { name: 'Dry Goods & Spices', color: '#8b5cf6', description: 'Rice, flour, oils, lentils, and dry spices' },
          { name: 'Beverages & Syrups', color: '#06b6d4', description: 'Soft drinks, juices, coffee, tea, and bar mixes' },
          { name: 'Packaging & Disposables', color: '#64748b', description: 'Takeaway containers, cups, cutlery, and bags' },
          { name: 'Bakery & Pastry', color: '#ec4899', description: 'Breads, buns, desserts, and baking supplies' },
          { name: 'Sauces & Condiments', color: '#f97316', description: 'Ketchups, dressings, pastes, and condiments' },
        ],
      };

      const categoriesToSeed = verticalCategoriesMap[businessType] || verticalCategoriesMap.restaurant;

      for (const c of categoriesToSeed) {
        await client.query(
          `INSERT INTO categories (id, restaurant_id, name, color, description)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), id, c.name, c.color, c.description]
        );
      }

      // 7. Seed standard default dining tables / sections for floor management
      const defaultTables = [
        { num: 'T1', name: 'Table 1', section: 'Main Hall', cap: 4 },
        { num: 'T2', name: 'Table 2', section: 'Main Hall', cap: 4 },
        { num: 'T3', name: 'Table 3', section: 'Main Hall', cap: 2 },
        { num: 'T4', name: 'Table 4', section: 'Family Section', cap: 6 },
        { num: 'T5', name: 'Table 5', section: 'Outdoor Garden', cap: 4 },
        { num: 'VIP1', name: 'VIP Lounge 1', section: 'VIP Section', cap: 8 },
      ];
      for (const t of defaultTables) {
        await client.query(
          `INSERT INTO dining_tables (id, restaurant_id, branch_id, table_number, name, section, seating_capacity, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'available')`,
          [randomUUID(), id, mainBranchId, t.num, t.name, t.section, t.cap]
        );
      }

      // 7. Welcome notification tailored to vertical
      const verticalTitles: Record<string, string> = {
        hotel: 'Welcome to BhojMitra Hotel & Resort Management!',
        hospital: 'Welcome to BhojMitra Healthcare & Hospital Management!',
        grocery: 'Welcome to BhojMitra Supermarket & Grocery Store!',
        sweet_shop: 'Welcome to BhojMitra Sweet Shop & Mithai Production!',
        bakery: 'Welcome to BhojMitra Bakery Management!',
        cafe: 'Welcome to BhojMitra Cafe & Beverage Operations!',
        retail: 'Welcome to BhojMitra Retail Store Management!',
        restaurant: 'Welcome to BhojMitra Restaurant Operations!',
      };

      await client.query(
        `INSERT INTO notifications (id, partner_id, type, title, message)
         VALUES ($1, $2, 'system', $3, 'Your workspace has been customized with industry-tailored inventory categories and units.')`,
        [randomUUID(), id, verticalTitles[businessType] || verticalTitles.restaurant]
      );

      // 8. Auto-provision Free Trial subscription (14 days, max 1 branch, max 2 users)
      const trialPlan = (await client.query("SELECT id, name FROM subscription_plans WHERE LOWER(name) LIKE '%trial%' ORDER BY id ASC LIMIT 1")).rows[0];
      const trialPlanId = trialPlan ? trialPlan.id : 1;
      await client.query(
        `INSERT INTO subscriptions (id, partner_id, plan_id, plan, billing_cycle, status, start_date, expiry_date, auto_renew, amount)
         VALUES ($1, $2, $3, 'trial', 'monthly', 'trial', NOW(), NOW() + INTERVAL '14 days', FALSE, 0)`,
        [randomUUID(), id, trialPlanId]
      );

      // 9. Activity Log for Super Admin
      await client.query(
        `INSERT INTO activity_logs (id, restaurant_id, user_id, user_name, action, entity_type, entity_id, description, ip_address, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [
          randomUUID(),
          id,
          id,
          ownerNameTrimmed,
          'Restaurant Registered',
          'partner',
          id,
          `New ${businessType} '${restoNameTrimmed}' registered by ${ownerNameTrimmed}`,
          req.ip || '127.0.0.1',
        ]
      );

      await client.query('COMMIT');
      return res.status(201).json({ token: tokenFor(id), user: { id, email: emailLower } });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } catch { return res.status(409).json({ error: 'An account with this email already exists.' }); }
});
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await first('SELECT id,email,password_hash FROM users WHERE email=$1', [email]);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const partner = await first('SELECT id, restaurant_name, owner_name, status FROM partners WHERE id = $1', [user.id]);
  const restoUser = await first('SELECT id, status FROM restaurant_users WHERE auth_user_id = $1 OR id = $1', [user.id]);
  
  if (partner?.status === 'suspended' || restoUser?.status === 'suspended') {
    return res.status(403).json({
      error: 'Your account has been suspended by BhojMitra Admin. Please contact support at support@bhojmitra.in.',
      code: 'ACCOUNT_SUSPENDED'
    });
  }

  logAdminActivity(partner?.id || user.id, user.id, partner?.owner_name || user.email, 'User Login', 'user', user.id, `User logged in: ${user.email}`, req.ip);
  return res.json({ token: tokenFor(user.id), user: { id: user.id, email: user.email } });
});
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  const user = await first('SELECT id, email FROM users WHERE email = $1', [email]);
  return res.json({ success: true, message: 'Password reset link sent to your email.' });
});
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Valid email and password (min 6 characters) are required.' });
  }
  const user = await first('SELECT id FROM users WHERE email = $1', [String(email).trim().toLowerCase()]);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  const hashed = await bcrypt.hash(password, 12);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, user.id]);
  return res.json({ success: true, message: 'Password updated successfully.' });
});
app.post('/api/auth/update-password', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId;
  const { password } = req.body || {};
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const hashed = await bcrypt.hash(password, 12);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, userId]);
  return res.json({ success: true, message: 'Password updated successfully.' });
});
app.post('/api/demo-requests', async (req, res) => {
  try {
    const parsed = demoRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid demo request.' });
    const ref = referenceId('DMO');
    const d = parsed.data;
    const ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
    const request = await first(
      'INSERT INTO demo_requests (id,name,restaurant_name,email,phone,city,number_of_branches,preferred_date,preferred_time,message,reference_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [randomUUID(), d.name, d.restaurant_name, d.email, d.phone, d.city || 'India', d.number_of_branches || 1, d.preferred_date || null, d.preferred_time || null, d.message || null, ref]
    );
    await logActivity(null, null, d.name, 'Demo Requested', 'demo_requests', request.id, `New Demo Request from ${d.name} (${d.restaurant_name}, ${d.phone})`, String(ip));
    return res.status(201).json({ success: true, request, reference_id: ref });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/contact-queries', async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;
    if (![name, email, phone, subject, message].every((v) => typeof v === 'string' && v.trim())) {
      return res.status(400).json({ error: 'All contact fields are required.' });
    }
    const ref = referenceId('QRY');
    const ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
    const query = await first(
      'INSERT INTO contact_queries (id,name,email,phone,subject,message,reference_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [randomUUID(), name, email, phone, subject, message, ref]
    );
    await logActivity(null, null, name, 'Website Inquiry', 'contact_queries', query.id, `Contact query from ${name}: "${subject}"`, String(ip));
    return res.status(201).json({ success: true, query, reference_id: ref });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Instant Suspension Appeal Submission
app.post('/api/support/suspension-appeal', async (req, res) => {
  try {
    const { partnerId, userEmail, restaurantName, message, contactPhone } = req.body;
    if (!message || !userEmail) {
      return res.status(400).json({ error: 'Email and appeal message are required.' });
    }

    const ref = referenceId('APP');
    const ip = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';

    // Find matching partner if not provided
    let pId = partnerId;
    if (!pId) {
      const p = await first('SELECT id FROM partners WHERE LOWER(email) = $1', [String(userEmail).toLowerCase().trim()]);
      pId = p?.id;
    }

    if (pId) {
      await db.query(
        `INSERT INTO support_tickets (id, partner_id, ticket_number, subject, category, priority, status, message)
         VALUES ($1, $2, $3, $4, 'Account Suspension', 'urgent', 'new', $5)`,
        [
          randomUUID(),
          pId,
          ref,
          `Urgent Suspension Appeal - ${restaurantName || userEmail}`,
          `[Phone: ${contactPhone || 'N/A'}] ${message}`,
        ]
      );
    }

    await logAdminActivity(
      pId || null,
      null,
      userEmail,
      'Suspension Appeal Raised',
      'support_tickets',
      ref,
      `Suspension appeal #${ref} from ${restaurantName || userEmail} (${contactPhone || 'No phone'}): "${message.slice(0, 100)}"`,
      String(ip)
    );

    return res.status(201).json({
      success: true,
      ticketNumber: ref,
      message: 'Your suspension appeal has been submitted directly to Super Admin. Our team will review it urgently.',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LIVE VISITOR TRACKING & WEB PRESENCE
// ============================================================
app.post('/api/tracking/visit', async (req, res) => {
  try {
    const { sessionId, pathname, referrer, deviceType, browser, os, city, country } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    const ip = String(req.ip || req.headers['x-forwarded-for'] || '127.0.0.1');

    const existing = await first('SELECT id, landing_page FROM website_visitors WHERE session_id = $1', [sessionId]);
    if (existing) {
      await db.query(`
        UPDATE website_visitors
        SET current_page = $1, is_online = TRUE, last_heartbeat = NOW(), updated_at = NOW()
        WHERE session_id = $2
      `, [pathname || '/', sessionId]);
    } else {
      await db.query(`
        INSERT INTO website_visitors (id, session_id, ip_address, user_agent, device_type, browser, os, city, country, referrer, landing_page, current_page, time_spent_seconds, is_online, last_heartbeat, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, TRUE, NOW(), NOW(), NOW())
      `, [
        randomUUID(),
        sessionId,
        ip,
        req.headers['user-agent'] || '',
        deviceType || 'desktop',
        browser || 'Chrome',
        os || 'Windows',
        city || 'India',
        country || 'India',
        referrer || '',
        pathname || '/',
        pathname || '/'
      ]);
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/tracking/heartbeat', async (req, res) => {
  try {
    const { sessionId, incrementSeconds, isUnload } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    const inc = Number(incrementSeconds) || 15;
    const isOnline = !isUnload;

    await db.query(`
      UPDATE website_visitors
      SET time_spent_seconds = time_spent_seconds + $1,
          is_online = $2,
          last_heartbeat = NOW(),
          updated_at = NOW()
      WHERE session_id = $3
    `, [inc, isOnline, sessionId]);

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

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

    const rawSubPlan = sub ? String(sub.plan_name || sub.plan || 'basic').toLowerCase().trim() : null;
    const subscriptionPlan = (rawSubPlan === 'free trial' || rawSubPlan === 'trial') ? 'trial' : rawSubPlan;
    const defaultBranches = subscriptionPlan === 'pro' ? 9999 : subscriptionPlan === 'basic' ? 5 : subscriptionPlan === 'starter' ? 3 : subscriptionPlan === 'trial' ? 1 : 1;
    const defaultUsers = subscriptionPlan === 'pro' ? 9999 : subscriptionPlan === 'basic' ? 5 : subscriptionPlan === 'starter' ? 3 : subscriptionPlan === 'trial' ? 2 : 2;

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
        business_type: ssoRow.business_type || 'restaurant',
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

    const authUser = await first('SELECT id, email FROM users WHERE id = $1', [payload.sub]);
    const userEmail = authUser?.email?.toLowerCase() || '';

    // 1. Find user's active membership in restaurant_users (prioritizing the most recently updated active membership)
    let userRoleRow = await first(
      `SELECT ru.*, b.name AS branch_name
       FROM restaurant_users ru
       LEFT JOIN branches b ON b.id = ru.branch_id
       WHERE (ru.auth_user_id = $1 OR ru.id = $1 OR (LOWER(ru.email) = $2 AND $2 != '')) AND ru.status = 'active'
       ORDER BY ru.updated_at DESC NULLS LAST, ru.created_at DESC
       LIMIT 1`,
      [payload.sub, userEmail]
    );

    let partner: any = null;
    if (userRoleRow) {
      partner = await first('SELECT * FROM partners WHERE id = $1', [userRoleRow.restaurant_id]);
    }

    if (!partner) {
      partner = await first('SELECT * FROM partners WHERE id = $1 OR (LOWER(email) = $2 AND $2 != \'\')', [payload.sub, userEmail]);
    }

    if (!partner) return res.status(404).json({ error: 'Partner profile not found.' });

    if (partner.status === 'suspended' || userRoleRow?.status === 'suspended') {
      return res.status(403).json({
        error: 'Your account has been suspended by BhojMitra Admin. Please contact support at support@bhojmitra.in.',
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    await expireSubscriptions(partner.id);

    const isOwner = (userRoleRow?.role === 'owner' || partner.id === payload.sub || (userEmail && partner.email?.toLowerCase() === userEmail && userRoleRow?.restaurant_id === partner.id));

    if (isOwner) {
      if (!userRoleRow) {
        // Auto-heal owner record in restaurant_users
        const defaultBranch = await first('SELECT id, name FROM branches WHERE restaurant_id = $1 ORDER BY created_at ASC LIMIT 1', [partner.id]);
        const bId = defaultBranch?.id || null;
        const bName = defaultBranch?.name || null;
        try {
          await db.query(
            `INSERT INTO restaurant_users (id, restaurant_id, auth_user_id, full_name, email, phone, role, status, permissions, branch_id)
             VALUES ($1, $1, $1, $2, $3, $4, 'owner', 'active', $5, $6)
             ON CONFLICT (id) DO UPDATE SET role = 'owner', permissions = $5`,
            [partner.id, partner.owner_name, partner.email, partner.phone || null, JSON.stringify(['*']), bId]
          );
        } catch (healErr) {
          console.error('Auto-heal owner error:', healErr);
        }
        userRoleRow = {
          id: partner.id,
          restaurant_id: partner.id,
          auth_user_id: partner.id,
          branch_id: bId,
          branch_name: bName,
          full_name: partner.owner_name,
          email: partner.email,
          phone: partner.phone || null,
          role: 'owner',
          status: 'active',
          permissions: ['*'],
          created_at: partner.created_at,
        };
      } else {
        userRoleRow.role = 'owner';
      }
    }

    let parsedPermissions: string[] = isOwner ? ['*'] : [];
    if (userRoleRow?.permissions) {
      if (Array.isArray(userRoleRow.permissions)) {
        parsedPermissions = userRoleRow.permissions;
      } else if (typeof userRoleRow.permissions === 'string') {
        try {
          parsedPermissions = JSON.parse(userRoleRow.permissions);
        } catch {
          parsedPermissions = isOwner ? ['*'] : [];
        }
      }
    }
    if (isOwner && !parsedPermissions.includes('*')) {
      parsedPermissions = ['*'];
    }

    const restaurantUserObj = userRoleRow
      ? {
          id: userRoleRow.id,
          restaurant_id: partner.id,
          auth_user_id: userRoleRow.auth_user_id || payload.sub,
          branch_id: userRoleRow.branch_id || null,
          branch_name: userRoleRow.branch_name || null,
          full_name: userRoleRow.full_name || partner.owner_name,
          email: userRoleRow.email || partner.email,
          phone: userRoleRow.phone || partner.phone || null,
          role: isOwner ? 'owner' : (userRoleRow.role || 'staff'),
          status: userRoleRow.status || 'active',
          permissions: parsedPermissions,
          created_at: userRoleRow.created_at || partner.created_at,
        }
      : {
          id: partner.id,
          restaurant_id: partner.id,
          auth_user_id: partner.id,
          branch_id: null,
          branch_name: null,
          full_name: partner.owner_name,
          email: partner.email,
          phone: partner.phone || null,
          role: 'owner',
          status: 'active',
          permissions: ['*'],
          created_at: partner.created_at,
        };

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
      [partner.id]
    );

    const rawSubPlan = sub ? String(sub.plan_name || sub.plan || 'basic').toLowerCase().trim() : null;
    const subscriptionPlan = (rawSubPlan === 'free trial' || rawSubPlan === 'trial') ? 'trial' : rawSubPlan;
    const defaultBranches = subscriptionPlan === 'pro' ? 9999 : subscriptionPlan === 'basic' ? 5 : subscriptionPlan === 'starter' ? 3 : subscriptionPlan === 'trial' ? 1 : 1;
    const defaultUsers = subscriptionPlan === 'pro' ? 9999 : subscriptionPlan === 'basic' ? 5 : subscriptionPlan === 'starter' ? 3 : subscriptionPlan === 'trial' ? 2 : 2;

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
        id: payload.sub,
        email: restaurantUserObj.email,
        app_metadata: { provider: 'sso' },
        user_metadata: { full_name: restaurantUserObj.full_name, restaurant_name: partner.restaurant_name },
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
        business_type: partner.business_type || 'restaurant',
      },
      restaurantUser: restaurantUserObj,
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
  const rawPlanName = String(subscription.plan_name || subscription.plan || 'basic').toLowerCase().trim();
  const planName = (rawPlanName === 'free trial' || rawPlanName === 'trial') ? 'trial' : rawPlanName;
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

async function handleSelectPlan(req: AuthenticatedRequest, res: express.Response) {
  try {
    const partnerId = req.userId;
    if (!partnerId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const rawPlan = String(req.body.plan || '').toLowerCase().trim();
    if (!['trial', 'starter', 'basic', 'pro'].includes(rawPlan)) {
      return res.status(400).json({ success: false, error: 'Invalid plan selected. Choose trial, starter, basic, or pro.' });
    }

    const isTrial = (rawPlan === 'trial');
    const planPrices: Record<string, number> = {
      trial: 0,
      starter: 499,
      basic: 999,
      pro: 1999,
    };
    const maxBranchesMap: Record<string, number> = {
      trial: 1,
      starter: 3,
      basic: 5,
      pro: 9999,
    };
    const maxUsersMap: Record<string, number> = {
      trial: 2,
      starter: 3,
      basic: 5,
      pro: 9999,
    };

    const amount = planPrices[rawPlan] ?? 0;
    const maxBranches = maxBranchesMap[rawPlan] ?? 1;
    const maxUsers = maxUsersMap[rawPlan] ?? 2;
    const startDate = new Date();
    const expiryDate = new Date();
    if (isTrial) {
      expiryDate.setDate(expiryDate.getDate() + 14);
    } else {
      expiryDate.setDate(expiryDate.getDate() + 30);
    }

    const subStatus = isTrial ? 'trial' : 'active';
    const planRow = await first(
      'SELECT id FROM subscription_plans WHERE (LOWER(name) = $1 OR LOWER(name) = $2) AND is_active = TRUE LIMIT 1',
      [rawPlan, rawPlan === 'trial' ? 'free trial' : rawPlan]
    );

    const existingSub = await first(
      'SELECT id FROM subscriptions WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 1',
      [partnerId]
    );

    let subId = existingSub?.id;
    if (subId) {
      await db.query(
        `UPDATE subscriptions
         SET plan = $1,
             plan_id = $2,
             status = $3,
             amount = $4,
             billing_cycle = 'monthly',
             start_date = $5,
             expiry_date = $6,
             auto_renew = $7
         WHERE id = $8`,
        [rawPlan, planRow?.id || null, subStatus, amount, startDate, expiryDate, !isTrial, subId]
      );
    } else {
      subId = randomUUID();
      await db.query(
        `INSERT INTO subscriptions
         (id, partner_id, plan, plan_id, status, amount, billing_cycle, start_date, expiry_date, auto_renew)
         VALUES ($1, $2, $3, $4, $5, $6, 'monthly', $7, $8, $9)`,
        [subId, partnerId, rawPlan, planRow?.id || null, subStatus, amount, startDate, expiryDate, !isTrial]
      );
    }

    await db.query(
      `UPDATE partners
       SET status = 'active',
           free_trial_used_at = CASE WHEN $2 = 'trial' THEN COALESCE(free_trial_used_at, NOW()) ELSE free_trial_used_at END,
           onboarding_completed = TRUE,
           updated_at = NOW()
       WHERE id = $1`,
      [partnerId, rawPlan]
    );

    const updatedSub = {
      id: subId,
      restaurant_id: partnerId,
      plan: rawPlan,
      status: subStatus,
      start_date: startDate.toISOString().slice(0, 10),
      expiry_date: expiryDate.toISOString().slice(0, 10),
      billing_cycle: 'monthly',
      amount,
      currency: 'INR',
      auto_renewal: !isTrial,
      max_branches: maxBranches,
      max_users: maxUsers,
      created_at: startDate.toISOString(),
      updated_at: new Date().toISOString(),
    };

    return res.json({
      success: true,
      message: `${isTrial ? '14-Day Free Trial' : rawPlan.toUpperCase()} plan activated successfully!`,
      subscription: updatedSub,
    });
  } catch (err: any) {
    console.error('select-plan error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to activate plan' });
  }
}

app.post('/api/resto/select-plan', handleSelectPlan);
app.post('/api/subscriptions/select-plan', handleSelectPlan);
app.post('/api/resto/subscriptions/select-plan', handleSelectPlan);

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
  const ticketNumber = referenceId('TKT');
  const ticket = await first('INSERT INTO support_tickets (id,partner_id,ticket_number,subject,category,priority,message) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [randomUUID(), req.userId, ticketNumber, t.subject, t.category, t.priority, t.message]);
  logAdminActivity(req.userId || null, req.userId || null, null, 'Support Ticket Raised', 'support_ticket', ticket.id, `Ticket #${ticketNumber}: ${t.subject}`, req.ip);
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
  'stock_issue_items',
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
  'dining_tables',
  'sales_orders',
  'sales_order_items',
  'kot_tickets',
  'kot_items',
  'customers',
  'hotel_rooms',
  'hotel_bookings',
  'hotel_banquets',
  'hospital_departments',
  'hospital_patients',
  'patient_medicine_issues',
  'material_requests',
  'production_batches',
  'custom_orders',
  'customer_khata',
  'pos_held_bills',
  'day_closings',
  'purchase_payments',
  'inventory_locations',
  'location_inventory',
  'pos_outlets',
  'hotel_folio_transactions',
  'hotel_guests',
  'hotel_rate_plans',
  'hotel_folios',
  'hotel_folio_items',
  'hotel_room_moves',
  'kds_stations',
  'kds_priority_logs',
  'bar_bottle_sessions',
  'bar_daily_closings',
  'hotel_business_dates',
  'pool_ticket_types',
  'pool_tickets',
  'housekeeping_tasks',
  'engineering_tickets',
  'hotel_night_audits',
]);

const TABLES_WITHOUT_CREATED_AT = new Set([
  'stock_transfer_items',
  'stock_adjustment_items',
  'stock_count_items',
  'kitchen_requisition_items',
  'recipe_ingredients',
  'purchase_order_items',
  'stock_receipt_items',
  'purchase_return_items',
  'stock_issue_items',
  'sales_order_items',
  'kot_items',
  'location_inventory',
  'bar_bottle_sessions',
]);

const INDUSTRY_TABLE_RESTRICTIONS: Record<string, string[]> = {
  // Hospitality & Night Audit resources
  hotel_rooms: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  hotel_bookings: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  hotel_guests: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  hotel_rate_plans: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  hotel_folios: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  hotel_folio_items: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  hotel_room_moves: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  hotel_business_dates: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  hotel_banquets: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  hotel_folio_transactions: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  pool_ticket_types: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  pool_tickets: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet'],
  housekeeping_tasks: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet', 'hospital'],
  engineering_tickets: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet', 'hospital'],
  hotel_night_audits: ['hotel', 'resort', 'homestay', 'restaurant', 'cafe', 'club', 'banquet', 'sweet_shop', 'bakery', 'hospital', 'retail', 'grocery', 'f&b'],
  bar_bottle_sessions: ['hotel', 'resort', 'restaurant', 'cafe', 'club', 'lounge', 'bar'],
  bar_daily_closings: ['hotel', 'resort', 'restaurant', 'cafe', 'club', 'lounge', 'bar'],
  kds_stations: ['hotel', 'resort', 'restaurant', 'cafe', 'club', 'lounge', 'sweet_shop', 'bakery'],
  kds_priority_logs: ['hotel', 'resort', 'restaurant', 'cafe', 'club', 'lounge', 'sweet_shop', 'bakery'],

  // Healthcare / Hospital resources
  hospital_departments: ['hospital', 'clinic', 'pharmacy', 'restaurant', 'hotel'],
  hospital_patients: ['hospital', 'clinic', 'pharmacy', 'restaurant', 'hotel'],
  patient_medicine_issues: ['hospital', 'clinic', 'pharmacy', 'restaurant', 'hotel'],
  material_requests: ['hospital', 'clinic', 'pharmacy', 'restaurant', 'hotel'],

  // Sweet Shop & Bakery production resources
  production_batches: ['sweet_shop', 'bakery', 'restaurant', 'cafe', 'hotel', 'retail'],
  custom_orders: ['sweet_shop', 'bakery', 'restaurant', 'cafe', 'hotel', 'retail'],

  // Food & Beverage / Restaurant / Cafe / Hotel dining resources
  kot_tickets: ['restaurant', 'hotel', 'cafe', 'sweet_shop', 'bakery', 'resort', 'club'],
  kot_items: ['restaurant', 'hotel', 'cafe', 'sweet_shop', 'bakery', 'resort', 'club'],
  dining_tables: ['restaurant', 'hotel', 'cafe', 'sweet_shop', 'bakery', 'resort', 'club'],
};

async function checkIndustryAccess(partnerId: string, table: string): Promise<{ allowed: boolean; businessType: string }> {
  const allowedIndustries = INDUSTRY_TABLE_RESTRICTIONS[table];
  if (!allowedIndustries) return { allowed: true, businessType: 'common' };

  const partner = await first('SELECT business_type FROM partners WHERE id = $1', [partnerId]);
  let businessType = (partner?.business_type || 'restaurant').toLowerCase().trim();
  if (businessType === 'supermarket') businessType = 'grocery';
  if (businessType === 'sweet') businessType = 'sweet_shop';
  if (businessType === 'retail_shop') businessType = 'retail';

  if (allowedIndustries.includes(businessType)) {
    return { allowed: true, businessType };
  }
  return { allowed: false, businessType };
}

app.get('/api/resto/dashboard/stats', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const today = new Date().toISOString().slice(0, 10);

    const [
      itemStats,
      salesStats,
      poStats,
      todayTxns,
      branchCount,
      userCount,
    ] = await Promise.all([
      db.query(
        `SELECT 
           COUNT(*) as total_items,
           COALESCE(SUM(current_stock * purchase_price), 0) as inventory_value,
           COUNT(CASE WHEN current_stock > 0 AND current_stock <= minimum_stock THEN 1 END) as low_stock,
           COUNT(CASE WHEN current_stock <= 0 THEN 1 END) as out_of_stock
         FROM inventory_items 
         WHERE restaurant_id = $1`,
        [partnerId]
      ),
      db.query(
        `SELECT 
           COUNT(*) as total_orders,
           COALESCE(SUM(total_amount), 0) as total_sales,
           COALESCE(SUM(CASE WHEN DATE(created_at) = $2 THEN total_amount ELSE 0 END), 0) as today_sales
         FROM sales_orders 
         WHERE restaurant_id = $1`,
        [partnerId, today]
      ),
      db.query(
        `SELECT 
           COUNT(CASE WHEN status IN ('pending', 'pending_approval') THEN 1 END) as pending_pos,
           COUNT(*) as total_pos
         FROM purchase_orders 
         WHERE restaurant_id = $1`,
        [partnerId]
      ),
      db.query(
        `SELECT 
           COALESCE(SUM(CASE WHEN transaction_type = 'purchase' OR type = 'in' THEN ABS(COALESCE(quantity_change, quantity, 0) * COALESCE(unit_cost, unit_price, 0)) ELSE 0 END), 0) as today_purchases,
           COALESCE(SUM(CASE WHEN transaction_type = 'consumption' OR type = 'consumption' THEN ABS(COALESCE(quantity_change, quantity, 0) * COALESCE(unit_cost, unit_price, 0)) ELSE 0 END), 0) as today_consumption,
           COALESCE(SUM(CASE WHEN transaction_type = 'wastage' OR type = 'wastage' THEN ABS(COALESCE(quantity_change, quantity, 0) * COALESCE(unit_cost, unit_price, 0)) ELSE 0 END), 0) as today_wastage
         FROM stock_transactions 
         WHERE restaurant_id = $1 AND DATE(created_at) = $2`,
        [partnerId, today]
      ),
      db.query('SELECT COUNT(*) FROM branches WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT COUNT(*) FROM restaurant_users WHERE restaurant_id = $1', [partnerId]),
    ]);

    const iRow = itemStats.rows[0] || {};
    const sRow = salesStats.rows[0] || {};
    const poRow = poStats.rows[0] || {};
    const txRow = todayTxns.rows[0] || {};

    return res.json({
      totalItems: parseInt(iRow.total_items || '0', 10),
      inventoryValue: parseFloat(iRow.inventory_value || '0'),
      lowStockItems: parseInt(iRow.low_stock || '0', 10),
      outOfStockItems: parseInt(iRow.out_of_stock || '0', 10),
      totalSales: parseFloat(sRow.total_sales || '0'),
      todaySales: parseFloat(sRow.today_sales || '0'),
      totalOrders: parseInt(sRow.total_orders || '0', 10),
      pendingPOs: parseInt(poRow.pending_pos || '0', 10),
      totalPOs: parseInt(poRow.total_pos || '0', 10),
      todayPurchases: parseFloat(txRow.today_purchases || '0'),
      todayConsumption: parseFloat(txRow.today_consumption || '0'),
      todayWastage: parseFloat(txRow.today_wastage || '0'),
      totalBranches: parseInt(branchCount.rows[0]?.count || '0', 10),
      totalUsers: parseInt(userCount.rows[0]?.count || '0', 10),
    });
  } catch (err: any) {
    console.error('Error fetching resto dashboard stats:', err);
    return res.status(500).json({ error: err?.message || 'Failed to fetch dashboard stats' });
  }
});

app.get('/api/resto/:table', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  const table = String(req.params.table || '');
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!ALLOWED_RESTO_TABLES.has(table)) {
    return next();
  }

  const { allowed, businessType } = await checkIndustryAccess(partnerId, table);
  if (!allowed) {
    return res.status(403).json({
      error: `Access Denied: The resource '${table}' is not available for business vertical '${businessType}'.`,
      code: 'INDUSTRY_RESTRICTED',
    });
  }

  try {
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
      business_type: partner.business_type || 'restaurant',
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
    const rawPlanName = String(sub.plan_name || sub.plan || 'basic').toLowerCase().trim();
    const planName = (rawPlanName === 'free trial' || rawPlanName === 'trial') ? 'trial' : rawPlanName;
    const defaultBranches = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : planName === 'trial' ? 1 : 1;
    const defaultUsers = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : planName === 'trial' ? 2 : 2;
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

    if (key.endsWith('_gte')) {
      const col = key.replace(/_gte$/, '');
      if (validColRegex.test(col) && val !== undefined) {
        values.push(val);
        whereClause += ` AND "${col}" >= $${values.length}`;
      }
    } else if (key.endsWith('_lte')) {
      const col = key.replace(/_lte$/, '');
      if (validColRegex.test(col) && val !== undefined) {
        values.push(val);
        whereClause += ` AND "${col}" <= $${values.length}`;
      }
    } else if (key.endsWith('_gt')) {
      const col = key.replace(/_gt$/, '');
      if (validColRegex.test(col) && val !== undefined) {
        values.push(val);
        whereClause += ` AND "${col}" > $${values.length}`;
      }
    } else if (key.endsWith('_lt')) {
      const col = key.replace(/_lt$/, '');
      if (validColRegex.test(col) && val !== undefined) {
        values.push(val);
        whereClause += ` AND "${col}" < $${values.length}`;
      }
    } else if (key.endsWith('_neq')) {
      const col = key.replace(/_neq$/, '');
      if (validColRegex.test(col) && val !== undefined) {
        values.push(val);
        whereClause += ` AND "${col}" != $${values.length}`;
      }
    } else if (key.endsWith('_not_null') || (key.endsWith('_not') && String(val) === 'null')) {
      const col = key.replace(/_not_null$/, '').replace(/_not$/, '');
      if (validColRegex.test(col)) {
        whereClause += ` AND "${col}" IS NOT NULL`;
      }
    } else if (validColRegex.test(key) && val !== undefined) {
      const strVal = String(val);
      if (strVal.startsWith('gte.')) {
        values.push(strVal.slice(4));
        whereClause += ` AND "${key}" >= $${values.length}`;
      } else if (strVal.startsWith('lte.')) {
        values.push(strVal.slice(4));
        whereClause += ` AND "${key}" <= $${values.length}`;
      } else if (strVal.startsWith('gt.')) {
        values.push(strVal.slice(3));
        whereClause += ` AND "${key}" > $${values.length}`;
      } else if (strVal.startsWith('lt.')) {
        values.push(strVal.slice(3));
        whereClause += ` AND "${key}" < $${values.length}`;
      } else if (strVal.startsWith('neq.')) {
        values.push(strVal.slice(4));
        whereClause += ` AND "${key}" != $${values.length}`;
      } else if (strVal === 'null' || val === null) {
        whereClause += ` AND "${key}" IS NULL`;
      } else {
        values.push(val);
        whereClause += ` AND "${key}" = $${values.length}`;
      }
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
  } else if (!TABLES_WITHOUT_CREATED_AT.has(table)) {
    orderClause = ` ORDER BY created_at DESC`;
  }

  let limitClause = '';
  if (req.query.limit && !isNaN(Number(req.query.limit))) {
    limitClause = ` LIMIT ${Math.min(1000, Number(req.query.limit))}`;
  }

  let offsetClause = '';
  if (req.query.offset && !isNaN(Number(req.query.offset))) {
    offsetClause = ` OFFSET ${Math.max(0, Number(req.query.offset))}`;
  }

  const querySql = `SELECT * FROM ${table} ${whereClause}${orderClause}${limitClause}${offsetClause}`;
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
  } else if ((table === 'stock_transactions' || table === 'wastage_records') && rows.length > 0) {
    const [items, units] = await Promise.all([
      db.query('SELECT * FROM inventory_items WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM units WHERE restaurant_id = $1', [partnerId]),
    ]);
    const unitMap = Object.fromEntries(units.rows.map(u => [u.id, u]));
    const itemMap = Object.fromEntries(items.rows.map(i => {
      i.unit = unitMap[i.unit_id] || null;
      return [i.id, i];
    }));
    for (const row of rows) {
      row.item = itemMap[row.item_id] || null;
    }
  } else if (table === 'stock_transfers' && rows.length > 0) {
    const rowIds = rows.map(r => r.id);
    const [branches, items] = await Promise.all([
      db.query('SELECT * FROM branches WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM stock_transfer_items WHERE restaurant_id = $1 AND stock_transfer_id = ANY($2)', [partnerId, rowIds]),
    ]);
    const branchMap = Object.fromEntries(branches.rows.map(b => [b.id, b]));
    const itemsByTransfer: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByTransfer[it.stock_transfer_id]) itemsByTransfer[it.stock_transfer_id] = [];
      itemsByTransfer[it.stock_transfer_id].push(it);
    }
    for (const row of rows) {
      row.from_branch = branchMap[row.from_branch_id] || null;
      row.to_branch = branchMap[row.to_branch_id] || null;
      row.items = itemsByTransfer[row.id] || [];
    }
  } else if (table === 'purchase_orders' && rows.length > 0) {
    const rowIds = rows.map(r => r.id);
    const [supps, items] = await Promise.all([
      db.query('SELECT * FROM suppliers WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM purchase_order_items WHERE restaurant_id = $1 AND purchase_order_id = ANY($2)', [partnerId, rowIds]),
    ]);
    const suppMap = Object.fromEntries(supps.rows.map(s => [s.id, s]));
    const itemsByPO: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByPO[it.purchase_order_id]) itemsByPO[it.purchase_order_id] = [];
      itemsByPO[it.purchase_order_id].push(it);
    }
    for (const row of rows) {
      row.supplier = suppMap[row.supplier_id] || null;
      row.items = itemsByPO[row.id] || [];
    }
  } else if (table === 'stock_receipts' && rows.length > 0) {
    const rowIds = rows.map(r => r.id);
    const [supps, items] = await Promise.all([
      db.query('SELECT * FROM suppliers WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM stock_receipt_items WHERE restaurant_id = $1 AND stock_receipt_id = ANY($2)', [partnerId, rowIds]),
    ]);
    const suppMap = Object.fromEntries(supps.rows.map(s => [s.id, s]));
    const itemsByReceipt: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByReceipt[it.stock_receipt_id]) itemsByReceipt[it.stock_receipt_id] = [];
      itemsByReceipt[it.stock_receipt_id].push(it);
    }
    for (const row of rows) {
      row.supplier = suppMap[row.supplier_id] || null;
      row.items = itemsByReceipt[row.id] || [];
    }
  } else if (table === 'purchase_returns' && rows.length > 0) {
    const rowIds = rows.map(r => r.id);
    const [supps, items] = await Promise.all([
      db.query('SELECT * FROM suppliers WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM purchase_return_items WHERE restaurant_id = $1 AND purchase_return_id = ANY($2)', [partnerId, rowIds]),
    ]);
    const suppMap = Object.fromEntries(supps.rows.map(s => [s.id, s]));
    const itemsByReturn: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByReturn[it.purchase_return_id]) itemsByReturn[it.purchase_return_id] = [];
      itemsByReturn[it.purchase_return_id].push(it);
    }
    for (const row of rows) {
      row.supplier = suppMap[row.supplier_id] || null;
      row.items = itemsByReturn[row.id] || [];
    }
  } else if (table === 'stock_adjustments' && rows.length > 0) {
    const rowIds = rows.map(r => r.id);
    const items = await db.query('SELECT * FROM stock_adjustment_items WHERE restaurant_id = $1 AND stock_adjustment_id = ANY($2)', [partnerId, rowIds]);
    const itemsByAdj: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByAdj[it.stock_adjustment_id]) itemsByAdj[it.stock_adjustment_id] = [];
      itemsByAdj[it.stock_adjustment_id].push(it);
    }
    for (const row of rows) {
      row.items = itemsByAdj[row.id] || [];
    }
  } else if (table === 'stock_counts' && rows.length > 0) {
    const rowIds = rows.map(r => r.id);
    const [branches, items] = await Promise.all([
      db.query('SELECT * FROM branches WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM stock_count_items WHERE restaurant_id = $1 AND stock_count_id = ANY($2)', [partnerId, rowIds]),
    ]);
    const branchMap = Object.fromEntries(branches.rows.map(b => [b.id, b]));
    const itemsByCount: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByCount[it.stock_count_id]) itemsByCount[it.stock_count_id] = [];
      itemsByCount[it.stock_count_id].push(it);
    }
    for (const row of rows) {
      row.branch = branchMap[row.branch_id] || null;
      row.items = itemsByCount[row.id] || [];
    }
  } else if (table === 'stock_issues' && rows.length > 0) {
    const rowIds = rows.map(r => r.id);
    const items = await db.query('SELECT * FROM stock_issue_items WHERE restaurant_id = $1 AND stock_issue_id = ANY($2)', [partnerId, rowIds]);
    const itemsByIssue: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByIssue[it.stock_issue_id]) itemsByIssue[it.stock_issue_id] = [];
      itemsByIssue[it.stock_issue_id].push(it);
    }
    for (const row of rows) {
      row.items = itemsByIssue[row.id] || [];
    }
  } else if (table === 'kitchen_requisitions' && rows.length > 0) {
    const rowIds = rows.map(r => r.id);
    const items = await db.query('SELECT * FROM kitchen_requisition_items WHERE restaurant_id = $1 AND kitchen_requisition_id = ANY($2)', [partnerId, rowIds]);
    const itemsByReq: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByReq[it.kitchen_requisition_id]) itemsByReq[it.kitchen_requisition_id] = [];
      itemsByReq[it.kitchen_requisition_id].push(it);
    }
    for (const row of rows) {
      row.items = itemsByReq[row.id] || [];
    }
  } else if (table === 'recipes' && rows.length > 0) {
    const rowIds = rows.map(r => r.id);
    const ingredients = await db.query('SELECT * FROM recipe_ingredients WHERE restaurant_id = $1 AND recipe_id = ANY($2)', [partnerId, rowIds]);
    const ingByRecipe: Record<string, any[]> = {};
    for (const ing of ingredients.rows) {
      if (!ingByRecipe[ing.recipe_id]) ingByRecipe[ing.recipe_id] = [];
      ingByRecipe[ing.recipe_id].push(ing);
    }
    for (const row of rows) {
      row.ingredients = ingByRecipe[row.id] || [];
    }
  } else if (table === 'menu_items' && rows.length > 0) {
    const recipes = await db.query('SELECT * FROM recipes WHERE restaurant_id = $1', [partnerId]);
    const recMap = Object.fromEntries(recipes.rows.map(r => [r.id, r]));
    for (const row of rows) {
      row.recipe = recMap[row.recipe_id] || null;
    }
  } else if (table === 'unit_conversions' && rows.length > 0) {
    const units = await db.query('SELECT * FROM units WHERE restaurant_id = $1', [partnerId]);
    const unitMap = Object.fromEntries(units.rows.map(u => [u.id, u]));
    for (const row of rows) {
      row.from_unit = unitMap[row.from_unit_id] || null;
      row.to_unit = unitMap[row.to_unit_id] || null;
    }
  } else if (table === 'location_inventory' && rows.length > 0) {
    const [items, locs] = await Promise.all([
      db.query('SELECT * FROM inventory_items WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM inventory_locations WHERE restaurant_id = $1', [partnerId]),
    ]);
    const itemMap = Object.fromEntries(items.rows.map(i => [i.id, i]));
    const locMap = Object.fromEntries(locs.rows.map(l => [l.id, l]));
    for (const row of rows) {
      row.item = itemMap[row.item_id] || null;
      row.location = locMap[row.location_id] || null;
    }
  } else if (table === 'pos_outlets' && rows.length > 0) {
    const locs = await db.query('SELECT * FROM inventory_locations WHERE restaurant_id = $1', [partnerId]);
    const locMap = Object.fromEntries(locs.rows.map(l => [l.id, l]));
    for (const row of rows) {
      row.location = locMap[row.location_id] || null;
      row.kitchen_location = locMap[row.kitchen_location_id] || null;
    }
  } else if (table === 'hotel_folio_transactions' && rows.length > 0) {
    const [bookings, rooms] = await Promise.all([
      db.query('SELECT * FROM hotel_bookings WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM hotel_rooms WHERE restaurant_id = $1', [partnerId]),
    ]);
    const bookingMap = Object.fromEntries(bookings.rows.map(b => [b.id, b]));
    const roomMap = Object.fromEntries(rooms.rows.map(r => [r.id, r]));
    for (const row of rows) {
      row.booking = bookingMap[row.booking_id] || null;
      row.room = roomMap[row.room_id] || null;
    }
  } else if (table === 'pool_tickets' && rows.length > 0) {
    const types = await db.query('SELECT * FROM pool_ticket_types WHERE restaurant_id = $1', [partnerId]);
    const typeMap = Object.fromEntries(types.rows.map(t => [t.id, t]));
    for (const row of rows) {
      row.ticket_type = typeMap[row.ticket_type_id] || null;
    }
  } else if (table === 'housekeeping_tasks' && rows.length > 0) {
    const rooms = await db.query('SELECT * FROM hotel_rooms WHERE restaurant_id = $1', [partnerId]);
    const roomMap = Object.fromEntries(rooms.rows.map(r => [r.id, r]));
    for (const row of rows) {
      row.room = roomMap[row.room_id] || null;
    }
  } else if (table === 'engineering_tickets' && rows.length > 0) {
    const [rooms, locs] = await Promise.all([
      db.query('SELECT * FROM hotel_rooms WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM inventory_locations WHERE restaurant_id = $1', [partnerId]),
    ]);
    const roomMap = Object.fromEntries(rooms.rows.map(r => [r.id, r]));
    const locMap = Object.fromEntries(locs.rows.map(l => [l.id, l]));
    for (const row of rows) {
      row.room = roomMap[row.room_id] || null;
      row.location = locMap[row.location_id] || null;
    }
  }

    return res.json({ data: rows });
  } catch (err: any) {
    console.error(`Error in GET /api/resto/${table}:`, err);
    return res.status(500).json({ error: err?.message || 'Database error occurred while fetching records' });
  }
});

app.post('/api/resto/:table', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  const table = String(req.params.table || '');
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!ALLOWED_RESTO_TABLES.has(table)) {
    return next();
  }

  const { allowed, businessType } = await checkIndustryAccess(partnerId, table);
  if (!allowed) {
    return res.status(403).json({
      error: `Access Denied: The resource '${table}' is not available for business vertical '${businessType}'.`,
      code: 'INDUSTRY_RESTRICTED',
    });
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
      const rawPlanName = String(sub?.plan_name || sub?.plan || 'trial').toLowerCase().trim();
      const planName = (rawPlanName === 'free trial' || rawPlanName === 'trial') ? 'trial' : rawPlanName;
      const defaultBranches = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : planName === 'trial' ? 1 : 1;
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
      const rawPlanName = String(sub?.plan_name || sub?.plan || 'trial').toLowerCase().trim();
      const planName = (rawPlanName === 'free trial' || rawPlanName === 'trial') ? 'trial' : rawPlanName;
      const defaultUsers = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : planName === 'trial' ? 2 : 2;
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

      // Universal empty string / null sanitization
      for (const k of Object.keys(item)) {
        if (item[k] === '' || item[k] === 'null' || item[k] === 'undefined') {
          item[k] = null;
        }
      }

      // Special table auto-mappings
      if (table === 'dining_tables') {
        item.name = item.name || item.table_number || item.table_name || 'Table';
        item.table_number = item.table_number || item.name || 'T-1';
      }
      if (table === 'suppliers') {
        if (item.gstin && !item.gst_number) item.gst_number = item.gstin;
        if (item.gst_number && !item.gstin) item.gstin = item.gst_number;
      }
      if (table === 'stock_transactions') {
        if (item.type && !item.transaction_type) item.transaction_type = item.type;
        if (item.transaction_type && !item.type) item.type = item.transaction_type;
        if (item.quantity !== undefined && item.quantity_change === undefined) {
          const qtyNum = Number(item.quantity);
          item.quantity_change = (item.type === 'out' || item.type === 'consumption' || item.type === 'wastage') ? -Math.abs(qtyNum) : Math.abs(qtyNum);
        }
        if (item.quantity_change !== undefined && item.quantity === undefined) {
          item.quantity = Math.abs(Number(item.quantity_change));
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
      if (table === 'restaurant_users') {
        const userEmail = item.email ? String(item.email).trim().toLowerCase() : '';
        const userPass = item.password ? String(item.password) : 'BhojMitra@123';
        delete item.password;

        if (userEmail) {
          const passHash = await bcrypt.hash(userPass, 12);
          const existingAuth = await first('SELECT id FROM users WHERE LOWER(email) = $1', [userEmail]);
          if (existingAuth) {
            item.auth_user_id = existingAuth.id;
            if (rawItem.password) {
              await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passHash, existingAuth.id]);
            }
          } else {
            const newAuthId = randomUUID();
            await db.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [newAuthId, userEmail, passHash]);
            item.auth_user_id = newAuthId;
          }
        }
      }

      if ('phone' in item && (!item.phone || !String(item.phone).trim())) {
        item.phone = null;
      }
      if ('auth_user_id' in item && (!item.auth_user_id || !String(item.auth_user_id).trim())) {
        item.auth_user_id = null;
      }

      const keys = Object.keys(item).filter(k => {
        if (table === 'menu_items' && k === 'category' && typeof item[k] === 'string') return true;
        return (
          k !== 'category' &&
          k !== 'unit' &&
          k !== 'supplier' &&
          k !== 'item' &&
          k !== 'from_unit' &&
          k !== 'to_unit' &&
          k !== 'items' &&
          k !== 'ingredients' &&
          k !== 'branch' &&
          k !== 'from_branch' &&
          k !== 'to_branch'
        );
      });
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

  const { allowed, businessType } = await checkIndustryAccess(partnerId, table);
  if (!allowed) {
    return res.status(403).json({
      error: `Access Denied: The resource '${table}' is not available for business vertical '${businessType}'.`,
      code: 'INDUSTRY_RESTRICTED',
    });
  }

  const id = (req.query.id || req.body?.id) as string;

  try {
    if (table === 'restaurants') {
      const { name, legal_name, phone, address, city, business_type } = req.body || {};
      const updated = await first(
        `UPDATE partners SET restaurant_name = COALESCE($1, restaurant_name), business_name = COALESCE($2, business_name), phone = COALESCE($3, phone), city = COALESCE($4, city), business_type = COALESCE($5, business_type), updated_at = NOW() WHERE id = $6 RETURNING *`,
        [name, legal_name, phone, city || address, business_type, partnerId]
      );
      return res.json({ data: updated });
    }

    const item = { ...req.body };
    delete item.id;
    delete item.restaurant_id;
    if (table !== 'menu_items' || typeof item.category !== 'string') {
      delete item.category;
    }
    delete item.unit;
    delete item.supplier;
    delete item.item;
    delete item.from_unit;
    delete item.to_unit;
    delete item.items;
    delete item.ingredients;
    delete item.branch;
    delete item.from_branch;
    delete item.to_branch;

    // Universal empty string / null sanitization
    for (const k of Object.keys(item)) {
      if (item[k] === '' || item[k] === 'null' || item[k] === 'undefined') {
        item[k] = null;
      }
    }

    // Special table auto-mappings
    if (table === 'dining_tables') {
      if (item.table_number && !item.name) item.name = item.table_number;
      if (item.name && !item.table_number) item.table_number = item.name;
    }
    if (table === 'suppliers') {
      if (item.gstin && !item.gst_number) item.gst_number = item.gstin;
      if (item.gst_number && !item.gstin) item.gstin = item.gst_number;
    }
    if (table === 'stock_transactions') {
      if (item.type && !item.transaction_type) item.transaction_type = item.type;
      if (item.transaction_type && !item.type) item.type = item.transaction_type;
      if (item.quantity !== undefined && item.quantity_change === undefined) {
        const qtyNum = Number(item.quantity);
        item.quantity_change = (item.type === 'out' || item.type === 'consumption' || item.type === 'wastage') ? -Math.abs(qtyNum) : Math.abs(qtyNum);
      }
    }

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
    const vals: any[] = keys.map(k => {
      const v = item[k];
      if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
        return JSON.stringify(v);
      }
      return v;
    });

    vals.push(partnerId);
    let whereClause = `WHERE restaurant_id = $${vals.length}`;

    if (id) {
      vals.push(id);
      whereClause += ` AND id = $${vals.length}`;
    } else {
      const validColRegex = /^[a-z0-9_]+$/i;
      for (const [qKey, qVal] of Object.entries(req.query)) {
        if (['id', 'order', 'limit', 'select', 'offset', 'restaurant_id'].includes(qKey)) continue;
        if (validColRegex.test(qKey) && qVal !== undefined) {
          vals.push(qVal === 'false' ? false : qVal === 'true' ? true : qVal);
          whereClause += ` AND "${qKey}" = $${vals.length}`;
        }
      }
    }

    const sql = `UPDATE ${table} SET ${setClauses} ${whereClause} RETURNING *`;
    const result = await db.query(sql, vals);
    return res.json({ data: id ? result.rows[0] || null : result.rows });
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

  const { allowed, businessType } = await checkIndustryAccess(partnerId, table);
  if (!allowed) {
    return res.status(403).json({
      error: `Access Denied: The resource '${table}' is not available for business vertical '${businessType}'.`,
      code: 'INDUSTRY_RESTRICTED',
    });
  }

  const id = (req.query.id || req.body?.id) as string;
  const vals: any[] = [partnerId];
  let whereClause = `WHERE restaurant_id = $1`;

  if (id) {
    vals.push(id);
    whereClause += ` AND id = $2`;
  } else {
    const validColRegex = /^[a-z0-9_]+$/i;
    for (const [qKey, qVal] of Object.entries(req.query)) {
      if (['id', 'order', 'limit', 'select', 'offset', 'restaurant_id'].includes(qKey)) continue;
      if (validColRegex.test(qKey) && qVal !== undefined) {
        vals.push(qVal === 'false' ? false : qVal === 'true' ? true : qVal);
        whereClause += ` AND "${qKey}" = $${vals.length}`;
      }
    }
  }

  try {
    await db.query(`DELETE FROM ${table} ${whereClause}`, vals);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    console.error(`Error in DELETE /api/resto/${table}:`, err);
    return res.status(500).json({ error: err?.message || 'Database error occurred while deleting record' });
  }
});

// ============================================================
// POS CHECKOUT & ORDER DISPATCH API
// ============================================================
// ATOMIC MULTI-LOCATION STOCK ADJUSTMENT HELPER
// ============================================================
async function adjustLocationStock(
  client: any,
  partnerId: string,
  locationId: string | null,
  itemId: string,
  qtyChange: number,
  refType: string,
  refId: string,
  notes: string = '',
  allowNegative: boolean = false
) {
  if (!itemId) return 0;
  const qty = Number(qtyChange);

  // If a location is specified, manage location_inventory
  let targetLocationId = locationId;
  if (!targetLocationId) {
    // Find default or first active location
    const defLoc = (
      await client.query(
        `SELECT id FROM inventory_locations WHERE restaurant_id = $1 AND (is_default = TRUE OR type = 'warehouse') ORDER BY is_default DESC, created_at ASC LIMIT 1`,
        [partnerId]
      )
    ).rows[0];
    if (defLoc) targetLocationId = defLoc.id;
  }

  let locQtyAfter = 0;
  if (targetLocationId) {
    const locRow = (
      await client.query(
        `SELECT * FROM location_inventory WHERE restaurant_id = $1 AND location_id = $2 AND item_id = $3 FOR UPDATE`,
        [partnerId, targetLocationId, itemId]
      )
    ).rows[0];

    const currentLocQty = locRow ? Number(locRow.quantity || 0) : 0;
    locQtyAfter = currentLocQty + qty;

    if (locQtyAfter < 0 && !allowNegative) {
      const itmInfo = (await client.query('SELECT name FROM inventory_items WHERE id = $1', [itemId])).rows[0];
      const locInfo = (await client.query('SELECT name FROM inventory_locations WHERE id = $1', [targetLocationId])).rows[0];
      throw new Error(`Insufficient stock for "${itmInfo?.name || itemId}" at "${locInfo?.name || 'Selected Location'}". Available: ${currentLocQty}, Required: ${Math.abs(qty)}`);
    }

    if (locRow) {
      await client.query(
        `UPDATE location_inventory SET quantity = $1, updated_at = NOW() WHERE id = $2`,
        [locQtyAfter, locRow.id]
      );
    } else {
      await client.query(
        `INSERT INTO location_inventory (id, restaurant_id, location_id, item_id, quantity, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [randomUUID(), partnerId, targetLocationId, itemId, locQtyAfter]
      );
    }
  }

  // Also update overall global inventory_items for seamless compatibility
  const globalRow = (
    await client.query(
      `SELECT current_stock, purchase_price FROM inventory_items WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
      [itemId, partnerId]
    )
  ).rows[0];

  let globalQtyAfter = 0;
  let unitCost = 0;
  if (globalRow) {
    unitCost = Number(globalRow.purchase_price || 0);
    const currGlobal = Number(globalRow.current_stock || 0);
    globalQtyAfter = Math.max(0, currGlobal + qty);
    await client.query(
      `UPDATE inventory_items SET current_stock = $1, updated_at = NOW() WHERE id = $2`,
      [globalQtyAfter, itemId]
    );
  }

  // Write immutable stock transaction record
  await client.query(
    `INSERT INTO stock_transactions
     (id, restaurant_id, branch_id, item_id, transaction_type, quantity_change, quantity_after, reference_type, reference_id, unit_cost, notes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
    [
      randomUUID(),
      partnerId,
      null,
      itemId,
      qty >= 0 ? (refType === 'transfer' ? 'transfer_in' : 'purchase') : (refType === 'consumption' ? 'consumption' : 'sales'),
      qty,
      targetLocationId ? locQtyAfter : globalQtyAfter,
      refType,
      refId,
      unitCost,
      notes,
    ]
  );

  return targetLocationId ? locQtyAfter : globalQtyAfter;
}

// ============================================================
// POS CHECKOUT WITH RECIPE BOM DEDUCTION & ROOM FOLIO
// ============================================================
app.post('/api/resto/sales-pos/checkout', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const {
    order_type = 'dine_in',
    table_id = null,
    customer_name,
    customer_phone,
    items = [],
    subtotal = 0,
    discount_amount = 0,
    discount_percent = 0,
    tax_amount = 0,
    tax_percent = 5,
    total_amount = 0,
    payment_mode = 'cash',
    payment_status = 'paid',
    notes = '',
    branch_id = null,
    outlet_id = null,
    outlet_name = null,
    location_id = null,
    is_room_charge = false,
    room_id = null,
    guest_booking_id = null,
  } = req.body || {};

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one order item is required.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Determine active inventory location for this checkout
    let activeLocationId = location_id;
    let resolvedOutletName = outlet_name;
    if (outlet_id && (!activeLocationId || !resolvedOutletName)) {
      const outletRow = (await client.query('SELECT * FROM pos_outlets WHERE id = $1 AND restaurant_id = $2', [outlet_id, partnerId])).rows[0];
      if (outletRow) {
        if (!activeLocationId) activeLocationId = outletRow.kitchen_location_id || outletRow.location_id;
        if (!resolvedOutletName) resolvedOutletName = outletRow.name;
      }
    }
    if (!activeLocationId) {
      const defaultLoc = (await client.query(`SELECT id FROM inventory_locations WHERE restaurant_id = $1 AND (type = 'kitchen' OR is_default = TRUE) ORDER BY is_default DESC LIMIT 1`, [partnerId])).rows[0];
      if (defaultLoc) activeLocationId = defaultLoc.id;
    }

    // 2. Generate Order & KOT Numbers
    const countRes = await client.query('SELECT COUNT(*) FROM sales_orders WHERE restaurant_id = $1', [partnerId]);
    const orderCount = parseInt(countRes.rows[0].count, 10) + 1;
    const orderNumber = `ORD-${String(orderCount).padStart(4, '0')}`;
    const kotNumber = `KOT-${String(orderCount).padStart(4, '0')}`;
    const orderId = randomUUID();
    const kotId = randomUUID();

    // 3. Update Dining Table status if table_id is provided
    let tableNumber = null;
    if (table_id) {
      const tableRow = (await client.query('SELECT * FROM dining_tables WHERE id = $1 AND restaurant_id = $2', [table_id, partnerId])).rows[0];
      if (tableRow) {
        tableNumber = tableRow.table_number || tableRow.name;
        await client.query(
          `UPDATE dining_tables SET status = $1, current_order_id = $2, updated_at = NOW() WHERE id = $3`,
          [payment_status === 'paid' || payment_mode === 'charge_to_room' ? 'available' : 'occupied', payment_status === 'paid' ? null : orderId, table_id]
        );
      }
    }

    // 4. Handle Room Folio Charge if selected
    let folioTxnId: string | null = null;
    let actualPaymentStatus = payment_status;
    let resolvedBookingId = guest_booking_id;
    let resolvedRoomId = room_id;

    if (payment_mode === 'charge_to_room' || payment_mode === 'room_folio' || is_room_charge) {
      actualPaymentStatus = 'charged_to_room';
      let bookingRow: any = null;

      if (resolvedBookingId) {
        bookingRow = (await client.query('SELECT * FROM hotel_bookings WHERE id = $1 AND restaurant_id = $2', [resolvedBookingId, partnerId])).rows[0];
      } else if (resolvedRoomId) {
        bookingRow = (await client.query(
          `SELECT * FROM hotel_bookings WHERE restaurant_id = $1 AND room_id = $2 AND status IN ('reserved', 'checked_in', 'admitted') ORDER BY created_at DESC LIMIT 1`,
          [partnerId, resolvedRoomId]
        )).rows[0];
      }

      if (!bookingRow) {
        throw new Error('No active checked-in guest booking found for this room to charge folio.');
      }

      resolvedBookingId = bookingRow.id;
      resolvedRoomId = bookingRow.room_id;
      folioTxnId = randomUUID();

      const folioChargeDesc = `${resolvedOutletName || 'POS Outlet'} Order #${orderNumber} (${order_type.replace('_', ' ')})`;

      // Insert into hotel_folio_transactions
      await client.query(
        `INSERT INTO hotel_folio_transactions
         (id, restaurant_id, booking_id, room_id, outlet_id, outlet_name, order_id, order_number, charge_type, description, amount, payment_status, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unpaid', $12, NOW())`,
        [
          folioTxnId,
          partnerId,
          resolvedBookingId,
          resolvedRoomId,
          outlet_id,
          resolvedOutletName || 'POS Outlet',
          orderId,
          orderNumber,
          order_type === 'room_service' ? 'room_service' : 'restaurant',
          folioChargeDesc,
          Number(total_amount),
          partnerId,
        ]
      );

      // Update hotel_bookings charges and balance due
      const existingFolio = Array.isArray(bookingRow.folio_charges) ? bookingRow.folio_charges : [];
      existingFolio.push({
        id: folioTxnId,
        order_id: orderId,
        order_number: orderNumber,
        outlet: resolvedOutletName || 'POS Outlet',
        description: folioChargeDesc,
        amount: Number(total_amount),
        date: new Date().toISOString(),
      });

      const updatedServiceCharge = Number(bookingRow.room_service_charge || 0) + Number(total_amount);
      const updatedTotalAmount = Number(bookingRow.total_amount || 0) + Number(total_amount);
      const updatedBalanceDue = Number(bookingRow.balance_due || 0) + Number(total_amount);

      await client.query(
        `UPDATE hotel_bookings
         SET room_service_charge = $1, total_amount = $2, balance_due = $3, folio_charges = $4, updated_at = NOW()
         WHERE id = $5`,
        [updatedServiceCharge, updatedTotalAmount, updatedBalanceDue, JSON.stringify(existingFolio), resolvedBookingId]
      );

      // Auto-post to multi-window folio (Window 2: Food & Beverage)
      let masterFolio = (await client.query('SELECT * FROM hotel_folios WHERE booking_id = $1 AND restaurant_id = $2', [resolvedBookingId, partnerId])).rows[0];
      if (!masterFolio) {
        const fId = randomUUID();
        const fNum = `FOL-${Date.now().toString().slice(-6)}`;
        masterFolio = (await client.query(
          `INSERT INTO hotel_folios (id, restaurant_id, booking_id, folio_number, guest_id, room_id, status, total_charges, balance_due, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, NOW(), NOW()) RETURNING *`,
          [fId, partnerId, resolvedBookingId, fNum, bookingRow.guest_id || null, resolvedRoomId || null, updatedTotalAmount, updatedBalanceDue]
        )).rows[0];
      } else {
        await client.query(
          `UPDATE hotel_folios SET total_charges = total_charges + $1, balance_due = balance_due + $1, updated_at = NOW() WHERE id = $2`,
          [Number(total_amount), masterFolio.id]
        );
      }

      await client.query(
        `INSERT INTO hotel_folio_items 
         (id, folio_id, booking_id, restaurant_id, window_number, transaction_type, charge_category, source_outlet_id, source_reference_id, description, amount, tax_amount, net_amount, currency, status, posted_by, created_at)
         VALUES ($1, $2, $3, $4, 2, 'DEBIT', 'FOOD_BEVERAGE', $5, $6, $7, $8, $9, $10, $11, 'POSTED', $12, NOW())`,
        [
          randomUUID(),
          masterFolio.id,
          resolvedBookingId,
          partnerId,
          outlet_id || null,
          orderId,
          folioChargeDesc,
          Number(subtotal),
          Number(tax_amount),
          Number(total_amount),
          'INR',
          partnerId
        ]
      );
    }

    // 5. Insert sales_orders
    const orderRow = (
      await client.query(
        `INSERT INTO sales_orders
         (id, restaurant_id, branch_id, table_id, order_number, order_type, customer_name, customer_phone, subtotal, discount_amount, discount_percent, tax_amount, tax_percent, total_amount, payment_status, payment_mode, status, notes, outlet_id, outlet_name, location_id, is_room_charge, room_id, guest_booking_id, folio_transaction_id, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'completed', $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW(), NOW())
         RETURNING *`,
        [
          orderId,
          partnerId,
          branch_id,
          table_id,
          orderNumber,
          order_type,
          customer_name || 'Walk-in Guest',
          customer_phone || null,
          Number(subtotal),
          Number(discount_amount),
          Number(discount_percent),
          Number(tax_amount),
          Number(tax_percent),
          Number(total_amount),
          actualPaymentStatus,
          payment_mode,
          notes,
          outlet_id,
          resolvedOutletName || 'Restaurant POS',
          activeLocationId,
          payment_mode === 'charge_to_room' || is_room_charge,
          resolvedRoomId,
          resolvedBookingId,
          folioTxnId,
          partnerId,
        ]
      )
    ).rows[0];

    // 6. Insert sales_order_items & execute AUTOMATIC RECIPE BOM or DIRECT INVENTORY DEDUCTION
    for (const itm of items) {
      const itmId = randomUUID();
      const qty = Number(itm.quantity || 1);
      const rate = Number(itm.unit_price || itm.rate || 0);
      const lineTotal = Number(itm.total_price || itm.total || qty * rate);

      await client.query(
        `INSERT INTO sales_order_items
         (id, sales_order_id, restaurant_id, item_id, menu_item_id, item_name, quantity, unit_price, tax_percent, total_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          itmId,
          orderId,
          partnerId,
          itm.item_id || null,
          itm.menu_item_id || null,
          itm.item_name || itm.name || 'Item',
          qty,
          rate,
          Number(itm.tax_percent || 0),
          lineTotal,
          itm.notes || null,
        ]
      );

      // A. If linked to a Menu Item, check for Recipe Ingredients and auto-deduct Bill of Materials
      if (itm.menu_item_id) {
        const menuItemRow = (await client.query('SELECT * FROM menu_items WHERE id = $1 AND restaurant_id = $2', [itm.menu_item_id, partnerId])).rows[0];
        if (menuItemRow && menuItemRow.recipe_id) {
          const ingredients = (await client.query('SELECT * FROM recipe_ingredients WHERE recipe_id = $1 AND restaurant_id = $2', [menuItemRow.recipe_id, partnerId])).rows;
          for (const ing of ingredients) {
            const ingQtyNeeded = Number(ing.quantity || 0) * qty;
            if (ing.item_id && ingQtyNeeded > 0) {
              await adjustLocationStock(
                client,
                partnerId,
                activeLocationId,
                ing.item_id,
                -ingQtyNeeded,
                'consumption',
                orderId,
                `POS Recipe Consumption: ${qty}x ${itm.name || itm.item_name || 'Dish'}`
              );
            }
          }
        }
      }

      // B. If linked directly to an Inventory Item (Non-recipe retail / beverage / liquor)
      if (itm.item_id) {
        let deductQty = qty;
        // Liquor unit conversions (e.g., selling 60 ML from a 750 ML bottle, or serving_size_ml)
        if (itm.serving_size_ml && itm.bottle_size_ml) {
          deductQty = (Number(itm.serving_size_ml) / Number(itm.bottle_size_ml)) * qty;
        } else if (itm.peg_ml && itm.bottle_ml) {
          deductQty = (Number(itm.peg_ml) / Number(itm.bottle_ml)) * qty;
        }

        await adjustLocationStock(
          client,
          partnerId,
          activeLocationId,
          itm.item_id,
          -deductQty,
          'sales',
          orderId,
          `POS Direct Sale: ${itm.name || itm.item_name || 'Item'} (${deductQty} units)`
        );
      }
    }

    // 7. Create KOT Ticket for kitchen display
    const kotTicket = (
      await client.query(
        `INSERT INTO kot_tickets
         (id, restaurant_id, branch_id, table_id, table_number, sales_order_id, kot_number, order_type, server_name, status, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, NOW(), NOW())
         RETURNING *`,
        [
          kotId,
          partnerId,
          branch_id,
          table_id,
          tableNumber,
          orderId,
          kotNumber,
          order_type,
          resolvedOutletName || 'POS Counter',
          notes,
        ]
      )
    ).rows[0];

    // Insert KOT Items
    for (const itm of items) {
      const itmName = itm.item_name || itm.name || 'Item';
      const itmStation = itm.station_code || getItemStation(itmName);
      await client.query(
        `INSERT INTO kot_items (id, kot_id, restaurant_id, item_name, quantity, unit, notes, status, station_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
        [
          randomUUID(),
          kotId,
          partnerId,
          itmName,
          Number(itm.quantity || 1),
          itm.unit || 'portion',
          itm.notes || null,
          itmStation,
        ]
      );
    }

    // 8. Update Customer Spend if customer_name or phone is provided
    if (customer_phone || customer_name) {
      const existingCust = (
        await client.query(
          `SELECT * FROM customers WHERE restaurant_id = $1 AND (phone = $2 OR name = $3) LIMIT 1`,
          [partnerId, customer_phone || '', customer_name || '']
        )
      ).rows[0];
      if (existingCust) {
        await client.query(
          `UPDATE customers SET total_orders = total_orders + 1, total_spend = total_spend + $1, updated_at = NOW() WHERE id = $2`,
          [Number(total_amount), existingCust.id]
        );
      } else {
        await client.query(
          `INSERT INTO customers (id, restaurant_id, name, phone, total_orders, total_spend)
           VALUES ($1, $2, $3, $4, 1, $5)`,
          [randomUUID(), partnerId, customer_name || 'Guest', customer_phone || null, Number(total_amount)]
        );
      }
    }

    // 9. If payment_mode is 'khata', record transaction in customer_khata ledger
    if (payment_mode === 'khata' && (customer_name || customer_phone)) {
      const khataRow = (
        await client.query(
          `SELECT * FROM customer_khata WHERE restaurant_id = $1 AND (phone = $2 OR customer_name = $3) LIMIT 1`,
          [partnerId, customer_phone || '', customer_name || '']
        )
      ).rows[0];

      const khataTx = {
        id: `TX-${Date.now()}`,
        date: new Date().toISOString().split('T')[0],
        type: 'credit_sale',
        amount: Number(total_amount),
        reference: `POS Sale ${orderNumber}`,
        notes: notes || 'POS Credit Sale',
      };

      if (khataRow) {
        const txList = Array.isArray(khataRow.transactions) ? khataRow.transactions : [];
        txList.push(khataTx);
        const newTotalCredit = Number(khataRow.total_credit || 0) + Number(total_amount);
        const newBalance = Number(khataRow.balance_due || 0) + Number(total_amount);
        await client.query(
          `UPDATE customer_khata SET total_credit = $1, balance_due = $2, transactions = $3, updated_at = NOW() WHERE id = $4`,
          [newTotalCredit, newBalance, JSON.stringify(txList), khataRow.id]
        );
      } else {
        const khataId = randomUUID();
        await client.query(
          `INSERT INTO customer_khata (id, restaurant_id, customer_name, phone, credit_limit, total_credit, total_paid, balance_due, status, transactions, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 15000, $5, 0, $5, 'active', $6, NOW(), NOW())`,
          [khataId, partnerId, customer_name || 'Guest Customer', customer_phone || null, Number(total_amount), JSON.stringify([khataTx])]
        );
      }
    }

    // 10. Immutable Activity Log
    await client.query(
      `INSERT INTO activity_logs (id, restaurant_id, user_id, user_name, action, entity_type, entity_id, description, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        randomUUID(),
        partnerId,
        partnerId,
        customer_name || 'POS Staff',
        'Order Placed',
        'sales_order',
        orderId,
        `POS Order #${orderNumber} placed for ${Number(total_amount)} (${payment_mode}${folioTxnId ? ' - Charged to Room' : ''})`,
        req.ip || '127.0.0.1',
      ]
    );

    await client.query('COMMIT');

    return res.json({
      success: true,
      data: {
        order: orderRow,
        kot: kotTicket,
        order_number: orderNumber,
        kot_number: kotNumber,
        folio_transaction_id: folioTxnId,
      },
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('POS Checkout error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to process POS checkout' });
  } finally {
    client.release();
  }
});

// ============================================================
// ATOMIC STOCK TRANSFER COMPLETION ENDPOINT
// ============================================================
app.post('/api/resto/stock-transfers/complete', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { transfer_id, from_location_id, to_location_id, items = [] } = req.body || {};

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let transferRecord: any = null;
    let actualFromLoc = from_location_id;
    let actualToLoc = to_location_id;
    let transferItems = items;

    if (transfer_id) {
      transferRecord = (await client.query('SELECT * FROM stock_transfers WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [transfer_id, partnerId])).rows[0];
      if (!transferRecord) throw new Error('Stock transfer record not found.');
      actualFromLoc = transferRecord.from_location_id || from_location_id;
      actualToLoc = transferRecord.to_location_id || to_location_id;
      if (transferItems.length === 0) {
        transferItems = (await client.query('SELECT * FROM stock_transfer_items WHERE stock_transfer_id = $1 AND restaurant_id = $2', [transfer_id, partnerId])).rows;
      }
    }

    if (!actualFromLoc || !actualToLoc) {
      throw new Error('Both from_location_id and to_location_id are required for stock transfer.');
    }
    if (actualFromLoc === actualToLoc) {
      throw new Error('Source location and destination location must be different.');
    }
    if (!transferItems || transferItems.length === 0) {
      throw new Error('Transfer must include at least one item.');
    }

    for (const itm of transferItems) {
      const itmId = itm.item_id;
      const itmQty = Number(itm.quantity || 0);
      if (!itmId || itmQty <= 0) continue;

      // Deduct from Source Location
      await adjustLocationStock(
        client,
        partnerId,
        actualFromLoc,
        itmId,
        -itmQty,
        'transfer',
        transfer_id || 'manual_transfer',
        `Transfer Out to Location ${actualToLoc}`
      );

      // Add to Destination Location
      await adjustLocationStock(
        client,
        partnerId,
        actualToLoc,
        itmId,
        itmQty,
        'transfer',
        transfer_id || 'manual_transfer',
        `Transfer In from Location ${actualFromLoc}`
      );
    }

    if (transfer_id) {
      await client.query(
        `UPDATE stock_transfers SET status = 'completed', completed_by = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [partnerId, transfer_id]
      );
    }

    await client.query('COMMIT');
    return res.json({ success: true, message: 'Stock transfer completed successfully.' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Stock transfer completion error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to complete stock transfer' });
  } finally {
    client.release();
  }
});

// ============================================================
// TENANT CONFIGURATION & INTERNATIONALIZATION ENDPOINT
// ============================================================
app.get('/api/resto/tenant-config', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const partner = (await db.query('SELECT id, restaurant_name, business_type, currency, currency_symbol, tax_name, default_tax_rate, locale FROM partners WHERE id = $1', [partnerId])).rows[0];
    if (!partner) return res.status(404).json({ error: 'Tenant not found' });

    return res.json({
      data: {
        currency: partner.currency || 'INR',
        currency_symbol: partner.currency_symbol || '₹',
        tax_name: partner.tax_name || 'GST',
        default_tax_rate: Number(partner.default_tax_rate || 5),
        locale: partner.locale || 'en-IN',
        restaurant_name: partner.restaurant_name,
        business_type: partner.business_type || 'restaurant',
      },
    });
  } catch (err: any) {
    console.error('Get tenant-config error:', err);
    return res.status(500).json({ error: 'Failed to fetch tenant configuration' });
  }
});

app.patch('/api/resto/tenant-config', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { currency, currency_symbol, tax_name, default_tax_rate, locale } = req.body || {};

  try {
    const updated = (
      await db.query(
        `UPDATE partners
         SET currency = COALESCE($1, currency),
             currency_symbol = COALESCE($2, currency_symbol),
             tax_name = COALESCE($3, tax_name),
             default_tax_rate = COALESCE($4, default_tax_rate),
             locale = COALESCE($5, locale),
             updated_at = NOW()
         WHERE id = $6
         RETURNING id, currency, currency_symbol, tax_name, default_tax_rate, locale`,
        [currency, currency_symbol, tax_name, default_tax_rate !== undefined ? Number(default_tax_rate) : null, locale, partnerId]
      )
    ).rows[0];

    return res.json({ success: true, data: updated });
  } catch (err: any) {
    console.error('Patch tenant-config error:', err);
    return res.status(500).json({ error: 'Failed to update tenant configuration' });
  }
});

// ============================================================
// ENTERPRISE HOTEL PMS, CHECK-IN & ROOM MOVE APIS
// ============================================================

// POST /api/resto/hotel/check-in (Strict Check-In Validation Engine)
app.post('/api/resto/hotel/check-in', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { booking_id, room_id, id_proof_type, id_proof_number, deposit_amount = 0, notes = '' } = req.body || {};
  if (!booking_id) return res.status(400).json({ error: 'booking_id is required for check-in' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch Booking and validate status
    const booking = (await client.query(
      'SELECT * FROM hotel_bookings WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [booking_id, partnerId]
    )).rows[0];

    if (!booking) throw new Error('Reservation not found.');
    if (booking.status === 'checked_in' || booking.status === 'checked_out') {
      throw new Error(`Cannot check in. Reservation is already ${booking.status.replace('_', ' ')}.`);
    }

    // 2. Validate Assigned Room
    const targetRoomId = room_id || booking.room_id;
    if (!targetRoomId) {
      throw new Error('A room must be assigned to complete check-in.');
    }

    const room = (await client.query(
      'SELECT * FROM hotel_rooms WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [targetRoomId, partnerId]
    )).rows[0];

    if (!room) throw new Error('Assigned room does not exist.');

    // 3. Strict Room Cleanliness Validation
    const cleanStatus = (room.cleaning_status || '').toLowerCase();
    const roomState = (room.status || '').toLowerCase();
    const roomStatusGranular = (room.room_status || '').toUpperCase();

    if (roomState === 'occupied' || cleanStatus === 'dirty' || cleanStatus === 'cleaning' || roomState === 'maintenance' || room.is_out_of_order) {
      throw new Error(`Cannot check in to Room ${room.room_number}. Room is currently ${cleanStatus || roomState} and not ready for guest arrival.`);
    }

    // 4. Update or Create Guest Profile KYC
    let guestId = booking.guest_id;
    if (!guestId && booking.guest_phone) {
      const existingGuest = (await client.query(
        'SELECT id FROM hotel_guests WHERE restaurant_id = $1 AND phone = $2 LIMIT 1',
        [partnerId, booking.guest_phone]
      )).rows[0];

      if (existingGuest) {
        guestId = existingGuest.id;
        await client.query(
          `UPDATE hotel_guests SET total_stays = total_stays + 1, updated_at = NOW() WHERE id = $1`,
          [guestId]
        );
      } else {
        guestId = randomUUID();
        await client.query(
          `INSERT INTO hotel_guests (id, restaurant_id, full_name, phone, email, id_proof_type, id_proof_number, total_stays, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NOW(), NOW())`,
          [
            guestId,
            partnerId,
            booking.guest_name,
            booking.guest_phone,
            booking.guest_email || null,
            id_proof_type || booking.id_proof_type || 'Aadhaar Card',
            id_proof_number || booking.id_proof_number || null,
          ]
        );
      }
    }

    // 5. Initialize Master Multi-Window Folio for this Stay
    let masterFolioId = booking.master_folio_id;
    if (!masterFolioId) {
      const existingFolio = (await client.query(
        'SELECT id FROM hotel_folios WHERE restaurant_id = $1 AND booking_id = $2 LIMIT 1',
        [partnerId, booking_id]
      )).rows[0];

      if (existingFolio) {
        masterFolioId = existingFolio.id;
      } else {
        masterFolioId = randomUUID();
        const folioNumber = `FOL-${Date.now().toString().slice(-6)}`;
        await client.query(
          `INSERT INTO hotel_folios (id, restaurant_id, booking_id, folio_number, guest_id, room_id, status, total_charges, balance_due, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, NOW(), NOW())`,
          [
            masterFolioId,
            partnerId,
            booking_id,
            folioNumber,
            guestId || null,
            targetRoomId,
            Number(booking.room_charge || 0),
            Math.max(0, Number(booking.room_charge || 0) - Number(booking.paid_amount || 0)),
          ]
        );

        // Auto-post initial Room Charge to Folio Window 1
        if (Number(booking.room_charge || 0) > 0) {
          const roomChargeId = randomUUID();
          await client.query(
            `INSERT INTO hotel_folio_items (id, folio_id, restaurant_id, booking_id, window_number, charge_category, source_module, description, amount, tax_amount, total_amount, payment_status, created_at)
             VALUES ($1, $2, $3, $4, 1, 'room_charge', 'front_desk', $5, $6, $7, $8, 'unpaid', NOW())`,
            [
              roomChargeId,
              masterFolioId,
              partnerId,
              booking_id,
              `Room Charge: Room ${room.room_number} (${booking.room_type || room.room_type || 'Standard'})`,
              Number(booking.room_charge || 0),
              Number(booking.tax_amount || 0),
              Number(booking.room_charge || 0) + Number(booking.tax_amount || 0),
            ]
          );
        }
      }
    }

    // 6. Update Room State to OCCUPIED_CLEAN
    await client.query(
      `UPDATE hotel_rooms SET status = 'occupied', room_status = 'OCCUPIED_CLEAN', cleaning_status = 'occupied', updated_at = NOW() WHERE id = $1`,
      [targetRoomId]
    );

    // 7. Update Booking to IN_HOUSE / checked_in
    const updatedBooking = (await client.query(
      `UPDATE hotel_bookings
       SET status = 'checked_in',
           reservation_status = 'IN_HOUSE',
           room_id = $1,
           room_number = $2,
           room_type = $3,
           guest_id = $4,
           master_folio_id = $5,
           actual_check_in = NOW(),
           deposit_amount = deposit_amount + $6,
           paid_amount = paid_amount + $6,
           balance_due = GREATEST(0, total_amount - (paid_amount + $6)),
           id_proof_type = COALESCE($7, id_proof_type),
           id_proof_number = COALESCE($8, id_proof_number),
           updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        targetRoomId,
        room.room_number,
        room.room_type,
        guestId || null,
        masterFolioId,
        Number(deposit_amount),
        id_proof_type || null,
        id_proof_number || null,
        booking_id,
      ]
    )).rows[0];

    // 8. Record Activity Log
    await logAdminActivity(
      partnerId,
      partnerId,
      booking.guest_name,
      'Guest Check-In',
      'hotel_booking',
      booking_id,
      `Guest ${booking.guest_name} checked in to Room ${room.room_number} (Folio #${masterFolioId.slice(0, 8)})`,
      req.ip
    );

    await client.query('COMMIT');
    return res.json({
      success: true,
      message: `Guest ${booking.guest_name} checked in successfully to Room ${room.room_number}.`,
      data: {
        booking: updatedBooking,
        room,
        master_folio_id: masterFolioId,
      },
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Check-In error:', err);
    return res.status(500).json({ error: err?.message || 'Check-in failed' });
  } finally {
    client.release();
  }
});

// POST /api/resto/hotel/room-move (Atomic Room Transfer with Audit Trail)
app.post('/api/resto/hotel/room-move', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { booking_id, to_room_id, new_room_id, reason, rate_difference = 0 } = req.body || {};
  const resolvedToRoomId = to_room_id || new_room_id;
  if (!booking_id || !resolvedToRoomId || !reason) {
    return res.status(400).json({ error: 'booking_id, to_room_id, and reason are required for room move.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const booking = (await client.query(
      'SELECT * FROM hotel_bookings WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [booking_id, partnerId]
    )).rows[0];

    if (!booking) throw new Error('Guest booking not found.');
    if (booking.status !== 'checked_in') {
      throw new Error('Only active checked-in in-house guests can be moved.');
    }

    const fromRoomId = booking.room_id;
    const fromRoom = (await client.query('SELECT * FROM hotel_rooms WHERE id = $1 AND restaurant_id = $2', [fromRoomId, partnerId])).rows[0];
    const toRoom = (await client.query('SELECT * FROM hotel_rooms WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [resolvedToRoomId, partnerId])).rows[0];

    if (!toRoom) throw new Error('Destination room not found.');
    if (toRoom.status === 'occupied' || (toRoom.cleaning_status && toRoom.cleaning_status === 'dirty')) {
      throw new Error(`Destination Room ${toRoom.room_number} is not ready/available for room move.`);
    }

    // 1. Record Room Move transaction
    const moveId = randomUUID();
    await client.query(
      `INSERT INTO hotel_room_moves (id, restaurant_id, booking_id, from_room_id, to_room_id, from_room_number, to_room_number, reason, rate_difference, moved_by, moved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        moveId,
        partnerId,
        booking_id,
        fromRoomId,
        resolvedToRoomId,
        fromRoom?.room_number || booking.room_number || 'Room',
        toRoom.room_number,
        reason,
        Number(rate_difference),
        partnerId,
      ]
    );

    // 2. Set Old Room to VACANT_DIRTY for Housekeeping
    if (fromRoomId) {
      await client.query(
        `UPDATE hotel_rooms SET status = 'cleaning', room_status = 'VACANT_DIRTY', cleaning_status = 'dirty', updated_at = NOW() WHERE id = $1`,
        [fromRoomId]
      );
      await client.query(
        `INSERT INTO housekeeping_tasks (id, restaurant_id, room_id, room_number, task_type, priority, status, notes, created_at)
         VALUES ($1, $2, $3, $4, 'room_move_cleaning', 'high', 'pending', $5, NOW())`,
        [randomUUID(), partnerId, fromRoomId, fromRoom?.room_number || 'Room', `Cleaning required after room move to Room ${toRoom.room_number}`]
      );
    }

    // 3. Set New Room to OCCUPIED_CLEAN
    await client.query(
      `UPDATE hotel_rooms SET status = 'occupied', room_status = 'OCCUPIED_CLEAN', cleaning_status = 'occupied', updated_at = NOW() WHERE id = $1`,
      [to_room_id]
    );

    // 4. Update Booking
    const updatedTotal = Number(booking.total_amount || 0) + Number(rate_difference);
    const updatedBalance = Math.max(0, Number(booking.balance_due || 0) + Number(rate_difference));
    await client.query(
      `UPDATE hotel_bookings
       SET room_id = $1, room_number = $2, room_type = $3, total_amount = $4, balance_due = $5, updated_at = NOW()
       WHERE id = $6`,
      [to_room_id, toRoom.room_number, toRoom.room_type, updatedTotal, updatedBalance, booking_id]
    );

    // 5. If rate difference, post line item to Folio Window 1
    if (Number(rate_difference) !== 0 && booking.master_folio_id) {
      await client.query(
        `INSERT INTO hotel_folio_items (id, folio_id, restaurant_id, booking_id, window_number, charge_category, source_module, description, amount, total_amount, payment_status, created_at)
         VALUES ($1, $2, $3, $4, 1, 'room_charge', 'front_desk', $5, $6, $6, 'unpaid', NOW())`,
        [
          randomUUID(),
          booking.master_folio_id,
          partnerId,
          booking_id,
          `Room Move Upgrade/Adjustment (Room ${fromRoom?.room_number} → ${toRoom.room_number})`,
          Number(rate_difference),
        ]
      );
    }

    await logAdminActivity(
      partnerId,
      partnerId,
      booking.guest_name,
      'Room Move',
      'hotel_room_move',
      moveId,
      `Guest ${booking.guest_name} moved from Room ${fromRoom?.room_number} to Room ${toRoom.room_number} (Reason: ${reason})`,
      req.ip
    );

    await client.query('COMMIT');
    return res.json({
      success: true,
      message: `Guest successfully moved to Room ${toRoom.room_number}. Old room marked for cleaning.`,
      to_room: toRoom,
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Room Move error:', err);
    return res.status(500).json({ error: err?.message || 'Room move failed' });
  } finally {
    client.release();
  }
});

// ============================================================
// ENTERPRISE MULTI-WINDOW FOLIO & SETTLEMENT APIS
// ============================================================

// GET /api/resto/hotel/folios/:bookingId
app.get('/api/resto/hotel/folios/:bookingId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });
  const { bookingId } = req.params;

  try {
    const booking = (await first('SELECT * FROM hotel_bookings WHERE id = $1 AND restaurant_id = $2', [bookingId, partnerId]));
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    let folio = (await first('SELECT * FROM hotel_folios WHERE booking_id = $1 AND restaurant_id = $2', [bookingId, partnerId]));
    if (!folio) {
      // Auto-provision folio if missing
      const fId = randomUUID();
      const fNum = `FOL-${Date.now().toString().slice(-6)}`;
      folio = (await first(
        `INSERT INTO hotel_folios (id, restaurant_id, booking_id, folio_number, guest_id, room_id, status, total_charges, balance_due, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, NOW(), NOW()) RETURNING *`,
        [fId, partnerId, bookingId, fNum, booking.guest_id || null, booking.room_id || null, Number(booking.room_charge || 0), Number(booking.balance_due || 0)]
      ));
    }

    const items = (await db.query(
      `SELECT * FROM hotel_folio_items WHERE booking_id = $1 AND restaurant_id = $2 ORDER BY created_at ASC`,
      [bookingId, partnerId]
    )).rows;

    // Group items into Windows 1 to 4
    const windows: Record<number, any[]> = { 1: [], 2: [], 3: [], 4: [] };
    items.forEach((itm: any) => {
      const w = itm.window_number || 1;
      if (!windows[w]) windows[w] = [];
      windows[w].push(itm);
    });

    const windowTotals = Object.entries(windows).map(([wNum, wItems]) => {
      const charges = wItems.filter(i => i.charge_category !== 'payment' && i.charge_category !== 'refund').reduce((s, i) => s + Number(i.total_amount || 0), 0);
      const payments = wItems.filter(i => i.charge_category === 'payment').reduce((s, i) => s + Number(i.amount || 0), 0);
      const refunds = wItems.filter(i => i.charge_category === 'refund').reduce((s, i) => s + Number(i.amount || 0), 0);
      return {
        window_number: Number(wNum),
        items: wItems,
        total_charges: charges,
        total_payments: payments,
        total_refunds: refunds,
        balance_due: Math.max(0, charges - payments + refunds),
      };
    });

    return res.json({
      success: true,
      data: {
        folio,
        booking,
        windows: windowTotals,
        total_charges: items.filter(i => i.charge_category !== 'payment').reduce((s, i) => s + Number(i.total_amount || 0), 0),
        total_paid: items.filter(i => i.charge_category === 'payment').reduce((s, i) => s + Number(i.amount || 0), 0),
      },
    });
  } catch (err: any) {
    console.error('Fetch Folio error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to fetch folio' });
  }
});

// POST /api/resto/hotel/folios/charge (Post Charge Item to Specific Folio Window)
app.post('/api/resto/hotel/folios/charge', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const {
    booking_id,
    window_number = 1,
    charge_category = 'other_charge',
    source_module = 'front_desk',
    outlet_id = null,
    outlet_name = null,
    description,
    amount = 0,
    tax_amount = 0,
    discount_amount = 0,
    reference_id = null,
  } = req.body || {};

  if (!booking_id || !description || Number(amount) <= 0) {
    return res.status(400).json({ error: 'booking_id, description, and positive amount are required.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const booking = (await client.query('SELECT * FROM hotel_bookings WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [booking_id, partnerId])).rows[0];
    if (!booking) throw new Error('Booking not found.');

    let folio = (await client.query('SELECT id FROM hotel_folios WHERE booking_id = $1 AND restaurant_id = $2', [booking_id, partnerId])).rows[0];
    const folioId = folio ? folio.id : randomUUID();

    if (!folio) {
      const folioNumber = `FOL-${Date.now().toString().slice(-6)}`;
      await client.query(
        `INSERT INTO hotel_folios (id, restaurant_id, booking_id, folio_number, guest_id, room_id, status, total_charges, balance_due, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', 0, 0, NOW(), NOW())`,
        [folioId, partnerId, booking_id, folioNumber, booking.guest_id || null, booking.room_id || null]
      );
    }

    const netAmount = Number(amount) + Number(tax_amount) - Number(discount_amount);
    const itemId = randomUUID();

    await client.query(
      `INSERT INTO hotel_folio_items
       (id, folio_id, restaurant_id, booking_id, window_number, charge_category, source_module, outlet_id, outlet_name, reference_id, description, amount, tax_amount, discount_amount, total_amount, payment_status, posted_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'unpaid', $16, NOW())`,
      [
        itemId,
        folioId,
        partnerId,
        booking_id,
        Number(window_number) || 1,
        charge_category,
        source_module,
        outlet_id,
        outlet_name,
        reference_id,
        description,
        Number(amount),
        Number(tax_amount),
        Number(discount_amount),
        netAmount,
        partnerId,
      ]
    );

    // Update booking & folio totals
    await client.query(
      `UPDATE hotel_bookings SET total_amount = total_amount + $1, balance_due = balance_due + $1, updated_at = NOW() WHERE id = $2`,
      [netAmount, booking_id]
    );
    await client.query(
      `UPDATE hotel_folios SET total_charges = total_charges + $1, balance_due = balance_due + $1, updated_at = NOW() WHERE id = $2`,
      [netAmount, folioId]
    );

    await client.query('COMMIT');
    return res.status(201).json({ success: true, message: 'Charge posted to folio successfully.', item_id: itemId });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Folio charge post error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to post folio charge' });
  } finally {
    client.release();
  }
});

// POST /api/resto/hotel/folios/split (Split Charges across Windows)
app.post('/api/resto/hotel/folios/split', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { item_ids, folio_item_id, target_window = 2 } = req.body || {};
  const targetIds = Array.isArray(item_ids) ? item_ids : (folio_item_id ? [folio_item_id] : []);

  if (targetIds.length === 0) {
    return res.status(400).json({ error: 'item_ids array or folio_item_id is required.' });
  }

  try {
    await db.query(
      `UPDATE hotel_folio_items SET window_number = $1 WHERE id = ANY($2::text[]) AND restaurant_id = $3`,
      [Number(target_window) || 2, targetIds, partnerId]
    );
    return res.json({ success: true, message: `Moved ${targetIds.length} item(s) to Folio Window ${target_window}.` });
  } catch (err: any) {
    console.error('Folio split error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to split folio items' });
  }
});

// POST /api/resto/hotel/folios/settle (Settle Window or Entire Folio & Checkout)
app.post('/api/resto/hotel/folios/settle', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const {
    booking_id,
    window_number = null,
    amount_paid,
    payment_mode = 'cash',
    discount_amount = 0,
    checkout_guest = false,
    notes = '',
  } = req.body || {};

  if (!booking_id || Number(amount_paid) < 0) {
    return res.status(400).json({ error: 'booking_id and valid amount_paid are required.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const booking = (await client.query('SELECT * FROM hotel_bookings WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [booking_id, partnerId])).rows[0];
    if (!booking) throw new Error('Booking not found.');

    const folio = (await client.query('SELECT * FROM hotel_folios WHERE booking_id = $1 AND restaurant_id = $2 FOR UPDATE', [booking_id, partnerId])).rows[0];
    const folioId = folio?.id || randomUUID();

    const paymentItemId = randomUUID();
    const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;

    // 1. Record payment transaction in folio items
    if (Number(amount_paid) > 0) {
      await client.query(
        `INSERT INTO hotel_folio_items
         (id, folio_id, restaurant_id, booking_id, window_number, charge_category, source_module, reference_id, description, amount, total_amount, payment_status, posted_by, created_at)
         VALUES ($1, $2, $3, $4, $5, 'payment', 'front_desk', $6, $7, $8, $8, 'settled', $9, NOW())`,
        [
          paymentItemId,
          folioId,
          partnerId,
          booking_id,
          window_number ? Number(window_number) : 1,
          invoiceNumber,
          `Payment Received via ${payment_mode.toUpperCase()} (Tax Invoice #${invoiceNumber})`,
          Number(amount_paid),
          partnerId,
        ]
      );
    }

    // 2. Mark folio items in this window as settled
    if (window_number) {
      await client.query(
        `UPDATE hotel_folio_items SET payment_status = 'settled' WHERE booking_id = $1 AND window_number = $2 AND restaurant_id = $3`,
        [booking_id, Number(window_number), partnerId]
      );
    } else {
      await client.query(
        `UPDATE hotel_folio_items SET payment_status = 'settled' WHERE booking_id = $1 AND restaurant_id = $2`,
        [booking_id, partnerId]
      );
    }

    // 3. Update booking paid & balance due
    const newPaid = Number(booking.paid_amount || 0) + Number(amount_paid);
    const newBalance = Math.max(0, Number(booking.total_amount || 0) - newPaid - Number(discount_amount));

    await client.query(
      `UPDATE hotel_bookings
       SET paid_amount = $1, balance_due = $2, payment_mode = $3, updated_at = NOW()
       WHERE id = $4`,
      [newPaid, newBalance, payment_mode, booking_id]
    );

    // 4. If checkout requested and balance is zero or settled
    if (checkout_guest || newBalance === 0) {
      await client.query(
        `UPDATE hotel_bookings
         SET status = 'checked_out', reservation_status = 'CHECKED_OUT', actual_check_out = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [booking_id]
      );

      if (booking.room_id) {
        await client.query(
          `UPDATE hotel_rooms SET status = 'cleaning', room_status = 'VACANT_DIRTY', cleaning_status = 'dirty', updated_at = NOW() WHERE id = $1`,
          [booking.room_id]
        );
        await client.query(
          `INSERT INTO housekeeping_tasks (id, restaurant_id, room_id, room_number, task_type, priority, status, notes, created_at)
           VALUES ($1, $2, $3, $4, 'checkout_cleaning', 'high', 'pending', $5, NOW())`,
          [randomUUID(), partnerId, booking.room_id, booking.room_number || 'Room', `Departure cleaning for guest ${booking.guest_name}`]
        );
      }
    }

    await logAdminActivity(
      partnerId,
      partnerId,
      booking.guest_name,
      'Folio Settlement',
      'hotel_folio',
      folioId,
      `Folio settled for guest ${booking.guest_name}: ${formatCurrency(Number(amount_paid))} paid via ${payment_mode} (Invoice #${invoiceNumber})`,
      req.ip
    );

    await client.query('COMMIT');
    return res.json({
      success: true,
      message: `Folio settled successfully. Tax Invoice #${invoiceNumber} generated.`,
      invoice_number: invoiceNumber,
      amount_paid: Number(amount_paid),
      balance_due: newBalance,
      is_checked_out: checkout_guest || newBalance === 0,
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Folio settle error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to settle folio' });
  } finally {
    client.release();
  }
});

// ============================================================
// HOUSEKEEPING & 10-STATE ROOM INSPECTION APIS
// ============================================================

// PATCH /api/resto/hotel/rooms/:id/cleaning-status
app.patch('/api/resto/hotel/rooms/:id/cleaning-status', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { cleaning_status, notes } = req.body || {};

  const valid10States = [
    'VACANT_CLEAN',
    'VACANT_DIRTY',
    'CLEANING',
    'CLEAN',
    'INSPECTION',
    'INSPECTED',
    'OCCUPIED_CLEAN',
    'OCCUPIED_DIRTY',
    'OUT_OF_ORDER',
    'OUT_OF_SERVICE',
  ];

  const normalized = String(cleaning_status || '').toUpperCase();
  if (!valid10States.includes(normalized)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${valid10States.join(', ')}` });
  }

  try {
    let mainStatus = 'available';
    if (normalized.includes('OCCUPIED')) mainStatus = 'occupied';
    else if (normalized === 'OUT_OF_ORDER' || normalized === 'OUT_OF_SERVICE') mainStatus = 'maintenance';
    else if (normalized === 'VACANT_CLEAN' || normalized === 'INSPECTED' || normalized === 'CLEAN') mainStatus = 'available';
    else mainStatus = 'cleaning';

    const isInspected = normalized === 'INSPECTED' || normalized === 'VACANT_CLEAN';

    const updated = (await db.query(
      `UPDATE hotel_rooms
       SET room_status = $1,
           cleaning_status = $2,
           status = $3,
           inspected_by = CASE WHEN $4 THEN $5 ELSE inspected_by END,
           inspected_at = CASE WHEN $4 THEN NOW() ELSE inspected_at END,
           updated_at = NOW()
       WHERE id = $6 AND restaurant_id = $7
       RETURNING *`,
      [normalized, normalized.toLowerCase(), mainStatus, isInspected, partnerId, id, partnerId]
    )).rows[0];

    if (!updated) return res.status(404).json({ error: 'Room not found' });

    return res.json({ success: true, data: updated, message: `Room ${updated.room_number} updated to ${normalized}.` });
  } catch (err: any) {
    console.error('Room cleaning status update error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to update cleaning status' });
  }
});

// POST /api/resto/hotel/housekeeping/inspect (Supervisor Approval Gate)
app.post('/api/resto/hotel/housekeeping/inspect', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { room_id, passed = true, supervisor_notes = '', checklist_results = [] } = req.body || {};
  if (!room_id) return res.status(400).json({ error: 'room_id is required' });

  try {
    const nextRoomStatus = passed ? 'VACANT_CLEAN' : 'VACANT_DIRTY';
    const nextCleaning = passed ? 'inspected' : 'dirty';
    const nextMain = passed ? 'available' : 'cleaning';

    const updated = (await db.query(
      `UPDATE hotel_rooms
       SET room_status = $1,
           cleaning_status = $2,
           status = $3,
           inspected_by = $4,
           inspected_at = NOW(),
           updated_at = NOW()
       WHERE id = $5 AND restaurant_id = $6
       RETURNING *`,
      [nextRoomStatus, nextCleaning, nextMain, partnerId, room_id, partnerId]
    )).rows[0];

    // If failed inspection, auto-create high priority rework task
    if (!passed) {
      await db.query(
        `INSERT INTO housekeeping_tasks (id, restaurant_id, room_id, room_number, task_type, priority, status, notes, created_at)
         VALUES ($1, $2, $3, $4, 'rework_cleaning', 'urgent', 'pending', $5, NOW())`,
        [randomUUID(), partnerId, room_id, updated?.room_number || 'Room', `Failed Inspection: ${supervisor_notes || 'Re-clean required'}`]
      );
    }

    return res.json({
      success: true,
      message: passed ? `Room ${updated.room_number} passed inspection and is ready for check-in.` : `Room ${updated.room_number} failed inspection and marked dirty.`,
      data: updated,
    });
  } catch (err: any) {
    console.error('Housekeeping inspect error:', err);
    return res.status(500).json({ error: err?.message || 'Inspection failed' });
  }
});

function getItemStation(itemName: string): string {
  const name = (itemName || '').toLowerCase();
  if (
    name.includes('drink') || name.includes('juice') || name.includes('beer') ||
    name.includes('cocktail') || name.includes('mocktail') || name.includes('wine') ||
    name.includes('whiskey') || name.includes('vodka') || name.includes('rum') ||
    name.includes('beverage') || name.includes('tea') || name.includes('coffee') ||
    name.includes('soda') || name.includes('shake') || name.includes('water') ||
    name.includes('lassi') || name.includes('mojito') || name.includes('cooler')
  ) {
    return 'bar';
  }
  if (
    name.includes('salad') || name.includes('dessert') || name.includes('ice cream') ||
    name.includes('cold') || name.includes('raita') || name.includes('curd') ||
    name.includes('pudding') || name.includes('kheer') || name.includes('halwa') ||
    name.includes('gulab') || name.includes('sweet')
  ) {
    return 'dessert';
  }
  if (
    name.includes('tandoor') || name.includes('tikka') || name.includes('naan') ||
    name.includes('roti') || name.includes('kebab') || name.includes('kabab') ||
    name.includes('kulcha') || name.includes('paratha') || name.includes('pizza')
  ) {
    return 'tandoor';
  }
  return 'kitchen';
}

// GET /api/resto/kds/tickets (Priority Queue with Station Filtering)
app.get('/api/resto/kds/tickets', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const station = String(req.query.station || 'all').toLowerCase().trim();

  try {
    // 1. Fetch active tickets sorted by priority and oldest fired time
    const tickets = (await db.query(
      `SELECT * FROM kot_tickets
       WHERE restaurant_id = $1 AND status IN ('pending', 'preparing', 'ready', 'partially_ready')
       ORDER BY 
         CASE priority
           WHEN 'URGENT' THEN 1
           WHEN 'HIGH' THEN 2
           WHEN 'NORMAL' THEN 3
           WHEN 'LOW' THEN 4
           ELSE 5
         END ASC,
         created_at ASC`,
      [partnerId]
    )).rows;

    const ticketIds = tickets.map((t: any) => t.id);
    let itemsByKot: Record<string, any[]> = {};

    if (ticketIds.length > 0) {
      const items = (await db.query(
        `SELECT * FROM kot_items WHERE restaurant_id = $1 AND kot_id = ANY($2::text[])`,
        [partnerId, ticketIds]
      )).rows;

      items.forEach((itm: any) => {
        const itemStation = itm.station_code || getItemStation(itm.item_name);
        if (station === 'all' || station === 'expeditor' || itemStation === station) {
          if (!itemsByKot[itm.kot_id]) itemsByKot[itm.kot_id] = [];
          itemsByKot[itm.kot_id].push({
            ...itm,
            station: itemStation,
          });
        }
      });
    }

    // Filter out tickets with 0 items for the selected station
    const stationTickets = tickets
      .map((t: any) => ({
        ...t,
        items: itemsByKot[t.id] || [],
      }))
      .filter((t: any) => station === 'all' || station === 'expeditor' || t.items.length > 0);

    return res.json({ success: true, data: stationTickets, count: stationTickets.length });
  } catch (err: any) {
    console.error('KDS tickets fetch error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to fetch KDS tickets' });
  }
});

// GET /api/resto/kds/all-day-production (Consolidated Dish Aggregation)
app.get('/api/resto/kds/all-day-production', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const station = String(req.query.station || 'all').toLowerCase().trim();

  try {
    const query = `
      SELECT 
        ki.item_name,
        ki.unit,
        COALESCE(ki.station_code, 'kitchen') as station,
        SUM(ki.quantity) as total_quantity,
        COUNT(DISTINCT kt.id) as total_tickets,
        json_agg(json_build_object(
          'kot_id', kt.id,
          'kot_number', kt.kot_number,
          'table_number', kt.table_number,
          'order_type', kt.order_type,
          'quantity', ki.quantity,
          'status', ki.status,
          'created_at', kt.created_at
        )) as orders
      FROM kot_items ki
      JOIN kot_tickets kt ON kt.id = ki.kot_id
      WHERE kt.restaurant_id = $1
        AND kt.status IN ('pending', 'preparing', 'partially_ready')
        AND ki.status IN ('pending', 'preparing')
      GROUP BY ki.item_name, ki.unit, COALESCE(ki.station_code, 'kitchen')
      ORDER BY total_quantity DESC
    `;

    const rawRows = (await db.query(query, [partnerId])).rows;
    const filtered = rawRows.filter((r: any) => station === 'all' || r.station === station);

    return res.json({ success: true, data: filtered });
  } catch (err: any) {
    console.error('All Day production error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to aggregate all day production' });
  }
});

// PATCH /api/resto/kds/items/:itemId/bump (Item-Level Bumping)
app.patch('/api/resto/kds/items/:itemId/bump', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { itemId } = req.params;
  const { target_status } = req.body || {};

  try {
    const item = (await db.query('SELECT * FROM kot_items WHERE id = $1 AND restaurant_id = $2', [itemId, partnerId])).rows[0];
    if (!item) return res.status(404).json({ error: 'KOT item not found' });

    let nextStatus = target_status;
    if (!nextStatus) {
      if (item.status === 'pending') nextStatus = 'preparing';
      else if (item.status === 'preparing') nextStatus = 'ready';
      else if (item.status === 'ready') nextStatus = 'served';
      else nextStatus = 'ready';
    }

    const updatedItem = (await db.query(
      `UPDATE kot_items SET status = $1, bumped_at = NOW() WHERE id = $2 AND restaurant_id = $3 RETURNING *`,
      [nextStatus, itemId, partnerId]
    )).rows[0];

    // Recalculate parent ticket status
    const allItems = (await db.query('SELECT status FROM kot_items WHERE kot_id = $1 AND restaurant_id = $2', [item.kot_id, partnerId])).rows;
    const allReady = allItems.every((i: any) => i.status === 'ready' || i.status === 'served');
    const anyPreparing = allItems.some((i: any) => i.status === 'preparing' || i.status === 'ready');

    let ticketStatus = 'pending';
    if (allReady) ticketStatus = 'ready';
    else if (anyPreparing) ticketStatus = 'partially_ready';

    await db.query(
      `UPDATE kot_tickets SET status = $1, ready_at = CASE WHEN $1 = 'ready' THEN NOW() ELSE ready_at END, updated_at = NOW() WHERE id = $2 AND restaurant_id = $3`,
      [ticketStatus, item.kot_id, partnerId]
    );

    return res.json({ success: true, item: updatedItem, ticket_status: ticketStatus });
  } catch (err: any) {
    console.error('KDS bump error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to bump KDS item' });
  }
});

// PATCH /api/resto/kds/tickets/:ticketId/priority (Priority Override with Mandatory Audit)
app.patch('/api/resto/kds/tickets/:ticketId/priority', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { ticketId } = req.params;
  const { priority, reason } = req.body || {};

  if (!priority || !reason) {
    return res.status(400).json({ error: 'priority (URGENT, HIGH, NORMAL, LOW) and reason are required.' });
  }

  try {
    const ticket = (await db.query('SELECT * FROM kot_tickets WHERE id = $1 AND restaurant_id = $2', [ticketId, partnerId])).rows[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const oldPrio = ticket.priority || 'NORMAL';
    const newPrio = String(priority).toUpperCase();

    // 1. Record Priority Change Audit Log
    await db.query(
      `INSERT INTO kds_priority_logs (id, restaurant_id, ticket_id, kot_number, old_priority, new_priority, reason, changed_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [randomUUID(), partnerId, ticketId, ticket.kot_number, oldPrio, newPrio, reason, partnerId]
    );

    // 2. Update Ticket Priority
    const updated = (await db.query(
      `UPDATE kot_tickets SET priority = $1, updated_at = NOW() WHERE id = $2 AND restaurant_id = $3 RETURNING *`,
      [newPrio, ticketId, partnerId]
    )).rows[0];

    return res.json({ success: true, data: updated, message: `Ticket #${ticket.kot_number} priority elevated to ${newPrio}.` });
  } catch (err: any) {
    console.error('KDS priority update error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to update priority' });
  }
});

// ============================================================
// BAR & LIQUOR DAILY CLOSING & PEG VARIANCE APIS
// ============================================================

// POST /api/resto/bar/daily-closing
app.post('/api/resto/bar/daily-closing', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { closing_date = new Date().toISOString().slice(0, 10), outlet_id = null, entries = [] } = req.body || {};
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'Bar closing entries are required.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const recorded: any[] = [];
    for (const e of entries) {
      const itmId = e.item_id;
      const itmName = e.item_name || 'Liquor Brand';
      const openMl = Number(e.opening_ml || 0);
      const recMl = Number(e.received_ml || 0);
      const soldMl = Number(e.sold_ml || 0);
      const wasteMl = Number(e.wastage_ml || 0);
      const physMl = Number(e.physical_closing_ml || 0);

      const theoClosing = openMl + recMl - soldMl - wasteMl;
      const varMl = physMl - theoClosing;
      const unitCostPerMl = Number(e.cost_per_ml || 0.5);
      const costVar = varMl * unitCostPerMl;

      const recordId = randomUUID();
      const row = (await client.query(
        `INSERT INTO bar_daily_closings
         (id, restaurant_id, closing_date, outlet_id, item_id, item_name, opening_ml, received_ml, sold_ml, wastage_ml, theoretical_closing_ml, physical_closing_ml, variance_ml, cost_variance, closed_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
         RETURNING *`,
        [recordId, partnerId, closing_date, outlet_id, itmId, itmName, openMl, recMl, soldMl, wasteMl, theoClosing, physMl, varMl, costVar, partnerId]
      )).rows[0];

      recorded.push(row);
    }

    await client.query('COMMIT');
    return res.status(201).json({ success: true, message: `Bar closing recorded for ${recorded.length} brands.`, data: recorded });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Bar closing error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to record bar closing' });
  } finally {
    client.release();
  }
});

// GET /api/resto/bar/variance-report
app.get('/api/resto/bar/variance-report', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const report = (await db.query(
      `SELECT * FROM bar_daily_closings WHERE restaurant_id = $1 ORDER BY closing_date DESC, item_name ASC LIMIT 100`,
      [partnerId]
    )).rows;

    const totalVolumeVariance = report.reduce((s, r) => s + Number(r.variance_ml || 0), 0);
    const totalCostVariance = report.reduce((s, r) => s + Number(r.cost_variance || 0), 0);

    return res.json({
      success: true,
      data: report,
      summary: {
        total_brands: report.length,
        total_volume_variance_ml: totalVolumeVariance,
        total_cost_variance: totalCostVariance,
      },
    });
  } catch (err: any) {
    console.error('Bar variance report error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to fetch bar variance report' });
  }
});

// ============================================================
// AUTOMATED 5-STEP NIGHT AUDIT & BUSINESS DATE CONTROL
// ============================================================

// GET /api/resto/night-audit/status
app.get('/api/resto/night-audit/status', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    let bizDateRow = (await first('SELECT * FROM hotel_business_dates WHERE restaurant_id = $1', [partnerId]));
    if (!bizDateRow) {
      const today = new Date().toISOString().slice(0, 10);
      bizDateRow = (await first(
        `INSERT INTO hotel_business_dates (id, restaurant_id, current_business_date, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *`,
        [randomUUID(), partnerId, today]
      ));
    }

    const curBizDate = bizDateRow.current_business_date;

    // Reconciliation Checks
    const [pendingArrivals, pendingDepartures, inHouseGuests, openFolios, todayPOS] = await Promise.all([
      db.query(`SELECT COUNT(*) as count FROM hotel_bookings WHERE restaurant_id = $1 AND check_in_date = $2 AND status = 'reserved'`, [partnerId, curBizDate]),
      db.query(`SELECT COUNT(*) as count FROM hotel_bookings WHERE restaurant_id = $1 AND check_out_date = $2 AND status = 'checked_in'`, [partnerId, curBizDate]),
      db.query(`SELECT COUNT(*) as count FROM hotel_bookings WHERE restaurant_id = $1 AND status = 'checked_in'`, [partnerId]),
      db.query(`SELECT COUNT(*) as count FROM hotel_folios WHERE restaurant_id = $1 AND status = 'open' AND balance_due > 0`, [partnerId]),
      db.query(`SELECT COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count FROM sales_orders WHERE restaurant_id = $1 AND DATE(created_at) = $2`, [partnerId, curBizDate]),
    ]);

    return res.json({
      success: true,
      data: {
        business_date: curBizDate,
        last_audit_date: bizDateRow.last_audit_date,
        is_in_progress: bizDateRow.is_audit_in_progress,
        checks: {
          pending_arrivals: parseInt(pendingArrivals.rows[0]?.count || '0', 10),
          pending_departures: parseInt(pendingDepartures.rows[0]?.count || '0', 10),
          in_house_guests: parseInt(inHouseGuests.rows[0]?.count || '0', 10),
          open_folios_with_balance: parseInt(openFolios.rows[0]?.count || '0', 10),
          today_pos_sales: parseFloat(todayPOS.rows[0]?.total || '0'),
          today_pos_orders: parseInt(todayPOS.rows[0]?.count || '0', 10),
        },
      },
    });
  } catch (err: any) {
    console.error('Night audit status error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to fetch night audit status' });
  }
});

// POST /api/resto/night-audit/run (Automated 5-Step Nightly Reconciliation & Date Roll)
app.post('/api/resto/night-audit/run', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch Current Business Date
    let bizRow = (await client.query('SELECT * FROM hotel_business_dates WHERE restaurant_id = $1 FOR UPDATE', [partnerId])).rows[0];
    const auditDate = bizRow?.current_business_date || new Date().toISOString().slice(0, 10);

    // 2. Fetch Active In-House Bookings & Auto-Post Room Charges + Taxes
    const inHouse = (await client.query(
      `SELECT * FROM hotel_bookings WHERE restaurant_id = $1 AND status = 'checked_in'`,
      [partnerId]
    )).rows;

    let totalNightlyRoomCharge = 0;
    for (const b of inHouse) {
      const roomCharge = Number(b.room_charge || 0);
      const roomTax = Math.round(roomCharge * 0.12);
      const totalPost = roomCharge + roomTax;

      if (roomCharge > 0 && b.master_folio_id) {
        await client.query(
          `INSERT INTO hotel_folio_items
           (id, folio_id, restaurant_id, booking_id, window_number, charge_category, source_module, description, amount, tax_amount, total_amount, payment_status, created_at)
           VALUES ($1, $2, $3, $4, 1, 'room_charge', 'night_audit', $5, $6, $7, $8, 'unpaid', NOW())`,
          [
            randomUUID(),
            b.master_folio_id,
            partnerId,
            b.id,
            `Night Audit Room Charge (${auditDate}): Room ${b.room_number || ''}`,
            roomCharge,
            roomTax,
            totalPost,
          ]
        );

        await client.query(
          `UPDATE hotel_bookings SET total_amount = total_amount + $1, balance_due = balance_due + $1, updated_at = NOW() WHERE id = $2`,
          [totalPost, b.id]
        );

        await client.query(
          `UPDATE hotel_folios SET total_charges = total_charges + $1, balance_due = balance_due + $1, updated_at = NOW() WHERE id = $2`,
          [totalPost, b.master_folio_id]
        );

        totalNightlyRoomCharge += roomCharge;
      }
    }

    // 3. Compute Outlets Revenue & Statistics for the Date
    const allRooms = (await client.query('SELECT * FROM hotel_rooms WHERE restaurant_id = $1', [partnerId])).rows;
    const totalRooms = allRooms.length;
    const occupiedRooms = inHouse.length;
    const occupancyRate = totalRooms > 0 ? Number(((occupiedRooms / totalRooms) * 100).toFixed(2)) : 0;
    const adr = occupiedRooms > 0 ? totalNightlyRoomCharge / occupiedRooms : 0;
    const revpar = totalRooms > 0 ? totalNightlyRoomCharge / totalRooms : 0;

    const posSales = (await client.query('SELECT COALESCE(SUM(total_amount), 0) as total FROM sales_orders WHERE restaurant_id = $1 AND DATE(created_at) = $2', [partnerId, auditDate])).rows[0];
    const banquetSales = (await client.query('SELECT COALESCE(SUM(total_amount), 0) as total FROM hotel_banquets WHERE restaurant_id = $1 AND event_date = $2', [partnerId, auditDate])).rows[0];
    const poolSales = (await client.query('SELECT COALESCE(SUM(total_amount), 0) as total FROM pool_tickets WHERE restaurant_id = $1 AND valid_date = $2', [partnerId, auditDate])).rows[0];

    const posRev = Number(posSales?.total || 0);
    const banqRev = Number(banquetSales?.total || 0);
    const poolRev = Number(poolSales?.total || 0);
    const totalDayRevenue = totalNightlyRoomCharge + posRev + banqRev + poolRev;

    // 4. Save Night Audit Record
    const auditNumber = `AUD-${Date.now().toString().slice(-6)}`;
    const auditRecord = (await client.query(
      `INSERT INTO hotel_night_audits
       (id, restaurant_id, audit_number, audit_date, room_revenue, pos_revenue, banquet_revenue, pool_revenue, total_revenue, total_rooms, occupied_rooms, occupancy_rate, audited_by, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'completed', NOW())
       RETURNING *`,
      [
        randomUUID(),
        partnerId,
        auditNumber,
        auditDate,
        totalNightlyRoomCharge,
        posRev,
        banqRev,
        poolRev,
        totalDayRevenue,
        totalRooms,
        occupiedRooms,
        occupancyRate,
        partnerId,
      ]
    )).rows[0];

    // 5. Roll Hotel Business Date to Next Operating Day (+1 Day)
    const nextDate = new Date(new Date(auditDate).getTime() + 86400000).toISOString().slice(0, 10);
    await client.query(
      `INSERT INTO hotel_business_dates (id, restaurant_id, current_business_date, last_audit_date, is_audit_in_progress, updated_at)
       VALUES ($1, $2, $3, $4, FALSE, NOW())
       ON CONFLICT (restaurant_id) DO UPDATE SET
         current_business_date = EXCLUDED.current_business_date,
         last_audit_date = EXCLUDED.last_audit_date,
         is_audit_in_progress = FALSE,
         updated_at = NOW()`,
      [randomUUID(), partnerId, nextDate, auditDate]
    );

    await logAdminActivity(
      partnerId,
      partnerId,
      'Night Auditor',
      'Night Audit Completed',
      'hotel_night_audit',
      auditRecord.id,
      `Night Audit #${auditNumber} executed for ${auditDate}. Revenue: ${formatCurrency(totalDayRevenue)}, Occupancy: ${occupancyRate}%, Next Date: ${nextDate}`,
      req.ip
    );

    await client.query('COMMIT');
    return res.json({
      success: true,
      message: `Night Audit #${auditNumber} completed. Business date rolled from ${auditDate} to ${nextDate}.`,
      data: {
        audit: auditRecord,
        previous_business_date: auditDate,
        new_business_date: nextDate,
        kpis: {
          occupancy_rate: `${occupancyRate}%`,
          adr: parseFloat(adr.toFixed(2)),
          revpar: parseFloat(revpar.toFixed(2)),
          total_revenue: totalDayRevenue,
          room_revenue: totalNightlyRoomCharge,
          pos_revenue: posRev,
          banquet_revenue: banqRev,
          pool_revenue: poolRev,
        },
      },
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Night audit execution error:', err);
    return res.status(500).json({ error: err?.message || 'Night audit failed' });
  } finally {
    client.release();
  }
});

// ============================================================
// HOSPITALITY KPI & EXECUTIVE SUMMARY REPORT API
// ============================================================
app.get('/api/resto/reports/hospitality-summary', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const today = new Date().toISOString().slice(0, 10);

    const [roomsRes, inHouseRes, salesRes, banquetsRes, poolRes, latestAuditRes] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM hotel_rooms WHERE restaurant_id = $1', [partnerId]),
      db.query(`SELECT COUNT(*) as count, COALESCE(SUM(room_charge), 0) as room_rev FROM hotel_bookings WHERE restaurant_id = $1 AND status = 'checked_in'`, [partnerId]),
      db.query(`SELECT COALESCE(SUM(total_amount), 0) as total FROM sales_orders WHERE restaurant_id = $1 AND DATE(created_at) = $2`, [partnerId, today]),
      db.query(`SELECT COALESCE(SUM(total_amount), 0) as total FROM hotel_banquets WHERE restaurant_id = $1 AND event_date = $2`, [partnerId, today]),
      db.query(`SELECT COALESCE(SUM(total_amount), 0) as total FROM pool_tickets WHERE restaurant_id = $1 AND valid_date = $2`, [partnerId, today]),
      db.query(`SELECT * FROM hotel_night_audits WHERE restaurant_id = $1 ORDER BY audit_date DESC LIMIT 7`, [partnerId]),
    ]);

    const totalRooms = parseInt(roomsRes.rows[0]?.count || '0', 10);
    const inHouseCount = parseInt(inHouseRes.rows[0]?.count || '0', 10);
    const roomRev = parseFloat(inHouseRes.rows[0]?.room_rev || '0');
    const posRev = parseFloat(salesRes.rows[0]?.total || '0');
    const banqRev = parseFloat(banquetsRes.rows[0]?.total || '0');
    const poolRev = parseFloat(poolRes.rows[0]?.total || '0');

    const occupancyRate = totalRooms > 0 ? Number(((inHouseCount / totalRooms) * 100).toFixed(1)) : 0;
    const adr = inHouseCount > 0 ? Math.round(roomRev / inHouseCount) : 0;
    const revpar = totalRooms > 0 ? Math.round(roomRev / totalRooms) : 0;
    const totalDailyRevenue = roomRev + posRev + banqRev + poolRev;

    return res.json({
      success: true,
      data: {
        total_rooms: totalRooms,
        occupied_rooms: inHouseCount,
        occupancy_rate: occupancyRate,
        adr,
        revpar,
        today_revenue: totalDailyRevenue,
        department_breakdown: {
          room: roomRev,
          pos_outlets: posRev,
          banquet: banqRev,
          pool: poolRev,
        },
        historical_audits: latestAuditRes.rows,
      },
    });
  } catch (err: any) {
    console.error('Hospitality report summary error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to generate hospitality report summary' });
  }
});

// ============================================================
// DIRECT WHATSAPP INVOICE DISPATCH API
// ============================================================
app.post('/api/resto/sales-pos/send-whatsapp', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { phone, order_number, message, customer_name, grand_total } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: 'Customer phone number is required.' });
  }

  const cleanPhone = String(phone).replace(/[^0-9]/g, '');
  const formattedPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;

  try {
    // 1. Fetch Restaurant details for sender branding
    const restRow = await first(`SELECT name, city, phone FROM restaurants WHERE id = $1 LIMIT 1`, [partnerId]);

    // 2. Record notification
    await db.query(
      `INSERT INTO notifications (id, restaurant_id, type, title, message, is_read, created_at)
       VALUES ($1, $2, 'whatsapp_invoice', $3, $4, FALSE, NOW())`,
      [
        randomUUID(),
        partnerId,
        `WhatsApp Bill Sent #${order_number || ''}`,
        `Direct WhatsApp Tax Invoice sent to +${formattedPhone} for Order #${order_number || ''}`,
      ]
    );

    // 3. If WhatsApp Cloud API / UltraMsg / Webhook credentials are set, dispatch in background
    if (process.env.WHATSAPP_API_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
      try {
        await fetch(`https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: formattedPhone,
            type: 'text',
            text: { preview_url: false, body: message },
          }),
        });
      } catch (gatewayErr) {
        console.warn('WhatsApp Cloud API Gateway warning:', gatewayErr);
      }
    }

    // UltraMsg Instance Support
    if (process.env.ULTRAMSG_INSTANCE_ID && process.env.ULTRAMSG_TOKEN) {
      try {
        await fetch(`https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE_ID}/messages/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: process.env.ULTRAMSG_TOKEN,
            to: formattedPhone,
            body: message,
          }),
        });
      } catch (ultraErr) {
        console.warn('UltraMsg Gateway warning:', ultraErr);
      }
    }

    // Custom Webhook Support
    if (process.env.WHATSAPP_WEBHOOK_URL) {
      try {
        await fetch(process.env.WHATSAPP_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: formattedPhone,
            phone: cleanPhone,
            message,
            order_number,
            sender: restRow?.phone || '6388433679',
          }),
        });
      } catch (webhookErr) {
        console.warn('Custom WhatsApp Webhook warning:', webhookErr);
      }
    }

    return res.json({
      success: true,
      message: `Tax Invoice #${order_number || ''} sent directly to customer WhatsApp (+${formattedPhone}) from ${restRow?.phone || '6388433679'}!`,
      delivered_to: formattedPhone,
    });
  } catch (err: any) {
    console.error('Error dispatching WhatsApp bill:', err);
    return res.status(500).json({ error: err.message || 'Failed to dispatch WhatsApp message.' });
  }
});

// PATCH /api/resto/kot/:id/status
app.patch('/api/resto/kot/:id/status', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { allowed, businessType } = await checkIndustryAccess(partnerId, 'kot_tickets');
  if (!allowed) {
    return res.status(403).json({
      error: `Access Denied: KOT status updates are not available for business vertical '${businessType}'.`,
      code: 'INDUSTRY_RESTRICTED',
    });
  }

  const { id } = req.params;
  const { status } = req.body || {};

  const validStatuses = ['pending', 'preparing', 'ready', 'served', 'cancelled'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const updated = await first(
      `UPDATE kot_tickets SET status = $1, updated_at = NOW() WHERE id = $2 AND restaurant_id = $3 RETURNING *`,
      [status, id, partnerId]
    );
    if (!updated) return res.status(404).json({ error: 'KOT Ticket not found' });

    await db.query(
      `UPDATE kot_items SET status = $1 WHERE kot_id = $2 AND restaurant_id = $3`,
      [status === 'served' ? 'ready' : status, id, partnerId]
    );

    return res.json({ success: true, data: updated });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to update KOT status' });
  }
});

// PATCH /api/resto/kot/items/:itemId/status (Item-Level Bumping)
app.patch('/api/resto/kot/items/:itemId/status', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { itemId } = req.params;
  const { status } = req.body || {};

  const validStatuses = ['pending', 'preparing', 'ready', 'served', 'cancelled'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid item status. Must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const updatedItem = await first(
      `UPDATE kot_items SET status = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING *`,
      [status, itemId, partnerId]
    );
    if (!updatedItem) return res.status(404).json({ error: 'KOT Item not found' });

    // Check if all items in this KOT ticket are now ready
    const allItems = (await db.query(`SELECT status FROM kot_items WHERE kot_id = $1 AND restaurant_id = $2`, [updatedItem.kot_id, partnerId])).rows;
    const allReady = allItems.length > 0 && allItems.every((i: any) => i.status === 'ready' || i.status === 'served');
    const anyPreparing = allItems.some((i: any) => i.status === 'preparing' || i.status === 'ready');

    let newTicketStatus = null;
    if (allReady) {
      newTicketStatus = 'ready';
    } else if (anyPreparing) {
      newTicketStatus = 'preparing';
    }

    if (newTicketStatus) {
      await db.query(
        `UPDATE kot_tickets SET status = $1, updated_at = NOW() WHERE id = $2 AND restaurant_id = $3 AND status != 'served'`,
        [newTicketStatus, updatedItem.kot_id, partnerId]
      );
    }

    return res.json({ success: true, data: updatedItem, ticketStatus: newTicketStatus });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to update KOT item status' });
  }
});

// POST /api/resto/kot/:id/recall (Recall served/cancelled KOT back to active board)
app.post('/api/resto/kot/:id/recall', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  const targetStatus = req.body?.targetStatus || 'preparing';

  try {
    const updated = await first(
      `UPDATE kot_tickets SET status = $1, updated_at = NOW() WHERE id = $2 AND restaurant_id = $3 RETURNING *`,
      [targetStatus, id, partnerId]
    );
    if (!updated) return res.status(404).json({ error: 'KOT Ticket not found' });

    await db.query(
      `UPDATE kot_items SET status = $1 WHERE kot_id = $2 AND restaurant_id = $3`,
      [targetStatus, id, partnerId]
    );

    return res.json({ success: true, data: updated });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to recall KOT ticket' });
  }
});

// GET /api/resto/kot/history (Fetch completed/served & cancelled KOT tickets)
app.get('/api/resto/kot/history', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const tickets = (
      await db.query(
        `SELECT * FROM kot_tickets WHERE restaurant_id = $1 AND status IN ('served', 'cancelled') ORDER BY updated_at DESC LIMIT 50`,
        [partnerId]
      )
    ).rows;

    const ticketIds = tickets.map((t: any) => t.id);
    let itemsByKot: Record<string, any[]> = {};
    if (ticketIds.length > 0) {
      const items = (
        await db.query(
          `SELECT * FROM kot_items WHERE restaurant_id = $1 AND kot_id = ANY($2::text[])`,
          [partnerId, ticketIds]
        )
      ).rows;
      items.forEach((itm: any) => {
        if (!itemsByKot[itm.kot_id]) itemsByKot[itm.kot_id] = [];
        itemsByKot[itm.kot_id].push(itm);
      });
    }

    const fullTickets = tickets.map((t: any) => ({
      ...t,
      items: itemsByKot[t.id] || [],
    }));

    return res.json({ success: true, data: fullTickets });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to fetch KOT history' });
  }
});

// GET /api/resto/kot (Full KOT Register with Advanced Filtering & Metrics)
app.get('/api/resto/kot', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const status = String(req.query.status || 'all').toLowerCase().trim();
  const orderType = String(req.query.order_type || 'all').toLowerCase().trim();
  const search = String(req.query.search || '').toLowerCase().trim();
  const limit = Math.min(Number(req.query.limit || 100), 200);

  try {
    let query = `SELECT * FROM kot_tickets WHERE restaurant_id = $1`;
    const params: any[] = [partnerId];

    if (status === 'active') {
      params.push(['pending', 'preparing', 'ready']);
      query += ` AND status = ANY($${params.length}::text[])`;
    } else if (status !== 'all' && ['pending', 'preparing', 'ready', 'served', 'cancelled'].includes(status)) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }

    if (orderType !== 'all') {
      params.push(orderType);
      query += ` AND order_type = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (LOWER(kot_number) LIKE $${params.length} OR LOWER(COALESCE(table_number, '')) LIKE $${params.length} OR LOWER(COALESCE(server_name, '')) LIKE $${params.length})`;
    }

    query += ` ORDER BY created_at DESC LIMIT ${limit}`;

    const tickets = (await db.query(query, params)).rows;
    const ticketIds = tickets.map((t: any) => t.id);

    let itemsByKot: Record<string, any[]> = {};
    if (ticketIds.length > 0) {
      const items = (
        await db.query(
          `SELECT * FROM kot_items WHERE restaurant_id = $1 AND kot_id = ANY($2::text[])`,
          [partnerId, ticketIds]
        )
      ).rows;
      items.forEach((itm: any) => {
        if (!itemsByKot[itm.kot_id]) itemsByKot[itm.kot_id] = [];
        itemsByKot[itm.kot_id].push({
          ...itm,
          station: itm.station_code || getItemStation(itm.item_name),
        });
      });
    }

    const fullTickets = tickets.map((t: any) => ({
      ...t,
      items: itemsByKot[t.id] || [],
    }));

    // Aggregate overall counts for today
    const statsRes = await db.query(
      `SELECT 
        COUNT(*) as total_today,
        COUNT(*) FILTER (WHERE status IN ('pending', 'preparing', 'ready')) as active_count,
        COUNT(*) FILTER (WHERE status = 'ready') as ready_count,
        COUNT(*) FILTER (WHERE status = 'served') as served_count,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_count
       FROM kot_tickets 
       WHERE restaurant_id = $1 AND created_at >= CURRENT_DATE`,
      [partnerId]
    );

    return res.json({
      success: true,
      data: fullTickets,
      count: fullTickets.length,
      stats: statsRes.rows[0] || {},
    });
  } catch (err: any) {
    console.error('KOT register fetch error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to fetch KOT register' });
  }
});

// POST /api/resto/kot/:id/void (Void/Cancel KOT with Audit Reason)
app.post('/api/resto/kot/:id/void', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  const reason = req.body?.reason?.trim() || 'Voided by Manager';

  try {
    const existing = await first(`SELECT * FROM kot_tickets WHERE id = $1 AND restaurant_id = $2`, [id, partnerId]);
    if (!existing) return res.status(404).json({ error: 'KOT ticket not found' });

    const notes = existing.notes ? `${existing.notes} | [VOID REASON: ${reason}]` : `[VOID REASON: ${reason}]`;

    const updated = await first(
      `UPDATE kot_tickets SET status = 'cancelled', notes = $1, updated_at = NOW() WHERE id = $2 AND restaurant_id = $3 RETURNING *`,
      [notes, id, partnerId]
    );

    await db.query(
      `UPDATE kot_items SET status = 'cancelled' WHERE kot_id = $1 AND restaurant_id = $2`,
      [id, partnerId]
    );

    // Audit logging
    await db.query(
      `INSERT INTO activity_logs (restaurant_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [partnerId, partnerId, 'VOID_KOT', 'kot_ticket', id, JSON.stringify({ kot_number: existing.kot_number, reason })]
    );

    return res.json({ success: true, message: `KOT #${existing.kot_number} voided successfully.`, data: updated });
  } catch (err: any) {
    console.error('KOT void error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to void KOT' });
  }
});

// POST /api/resto/kot/:id/reassign (Transfer KOT to different Table or Room)
app.post('/api/resto/kot/:id/reassign', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;
  const { table_number, table_name, order_type } = req.body || {};

  if (!table_number && !table_name) {
    return res.status(400).json({ error: 'New Table or Room number is required.' });
  }

  try {
    const updated = await first(
      `UPDATE kot_tickets 
       SET table_number = COALESCE($1, table_number), 
           table_name = COALESCE($2, table_name),
           order_type = COALESCE($3, order_type),
           updated_at = NOW() 
       WHERE id = $4 AND restaurant_id = $5 
       RETURNING *`,
      [table_number || null, table_name || null, order_type || null, id, partnerId]
    );

    if (!updated) return res.status(404).json({ error: 'KOT ticket not found' });

    return res.json({ success: true, message: `KOT successfully reassigned to ${table_name || table_number}.`, data: updated });
  } catch (err: any) {
    console.error('KOT reassign error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to reassign KOT' });
  }
});

// GET /api/resto/ai-insights/summary
app.get('/api/resto/ai-insights/summary', requireAuth, async (req: AuthenticatedRequest, res) => {
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [itemsRes, txnsRes, recipesRes, wastageRes, salesRes] = await Promise.all([
      db.query(`SELECT i.*, c.name as category_name, u.symbol as unit_symbol FROM inventory_items i LEFT JOIN categories c ON c.id = i.category_id LEFT JOIN units u ON u.id = i.unit_id WHERE i.restaurant_id = $1`, [partnerId]),
      db.query(`SELECT * FROM stock_transactions WHERE restaurant_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`, [partnerId]),
      db.query(`SELECT * FROM recipes WHERE restaurant_id = $1`, [partnerId]),
      db.query(`SELECT * FROM wastage_records WHERE restaurant_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`, [partnerId]),
      db.query(`SELECT * FROM sales_orders WHERE restaurant_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`, [partnerId]),
    ]);

    const items = itemsRes.rows;
    const txns = txnsRes.rows;
    const recipes = recipesRes.rows;
    const wastage = wastageRes.rows;
    const sales = salesRes.rows;

    // 1. Stock Runout & Reorder Predictions
    const runoutAlerts = items
      .map((item) => {
        const itemTxns = txns.filter((t) => t.item_id === item.id && (t.transaction_type === 'consumption' || t.transaction_type === 'sales'));
        const totalUsed = itemTxns.reduce((sum, t) => sum + Math.abs(Number(t.quantity_change || 0)), 0);
        const dailyBurnRate = totalUsed > 0 ? totalUsed / 30 : 0.5;
        const currentStock = Number(item.current_stock || 0);
        const daysRemaining = dailyBurnRate > 0 ? Math.round(currentStock / dailyBurnRate) : 999;
        const minStock = Number(item.minimum_stock || 0);
        const isUrgent = currentStock <= minStock || daysRemaining <= 3;

        return {
          id: item.id,
          name: item.name,
          category: item.category_name || 'General',
          unit: item.unit_symbol || 'units',
          current_stock: currentStock,
          daily_burn_rate: parseFloat(dailyBurnRate.toFixed(2)),
          days_remaining: daysRemaining,
          minimum_stock: minStock,
          is_urgent: isUrgent,
          recommendation: isUrgent ? `Order ${(minStock * 2) || 20} ${item.unit_symbol || 'units'} immediately to prevent stockout.` : 'Stock is within safe operational levels.',
        };
      })
      .filter((a) => a.is_urgent)
      .slice(0, 6);

    // 2. High Wastage Impact Analysis
    const wastageByItem: Record<string, { name: string; total_loss: number; count: number }> = {};
    for (const w of wastage) {
      const key = w.item_name || w.item_id || 'Other';
      if (!wastageByItem[key]) wastageByItem[key] = { name: key, total_loss: 0, count: 0 };
      wastageByItem[key].total_loss += Number(w.cost_impact || w.total_cost || 0);
      wastageByItem[key].count += 1;
    }
    const topWastage = Object.values(wastageByItem).sort((a, b) => b.total_loss - a.total_loss).slice(0, 5);

    // 3. Profit Margin Optimization
    const recipeMargins = recipes
      .map((r) => {
        const cost = Number(r.total_cost || r.cost_per_portion || 0);
        const price = Number(r.selling_price || 0);
        const margin = price > 0 ? ((price - cost) / price) * 100 : 0;
        return {
          id: r.id,
          name: r.name,
          cost,
          price,
          margin: parseFloat(margin.toFixed(1)),
          is_low_margin: margin < 60 && price > 0,
          recommendation: margin < 60 && price > 0 ? `Margin is ${margin.toFixed(0)}%. Consider increasing selling price to ₹${Math.round(cost / 0.35)} for target 65% gross margin.` : 'Healthy margin profile.',
        };
      })
      .slice(0, 5);

    // 4. Executive Summary KPI stats
    const totalWastageLoss = wastage.reduce((sum, w) => sum + Number(w.cost_impact || w.total_cost || 0), 0);
    const totalRevenue = sales.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
    const healthScore = Math.max(70, Math.min(98, 100 - runoutAlerts.length * 4 - (totalWastageLoss > 1000 ? 5 : 0)));

    return res.json({
      success: true,
      data: {
        health_score: healthScore,
        runout_alerts: runoutAlerts,
        top_wastage: topWastage,
        total_wastage_loss: totalWastageLoss,
        recipe_margins: recipeMargins,
        total_sales_30d: totalRevenue,
        order_count_30d: sales.length,
      },
    });
  } catch (err: any) {
    console.error('AI Insights error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to generate AI insights' });
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
    const partner = await first('SELECT id, email, owner_name FROM partners WHERE id = $1', [partnerId]);
    const users = await db.query(
      `SELECT ru.id, ru.restaurant_id, ru.full_name, ru.email, ru.phone, ru.role, ru.status, ru.permissions, ru.branch_id, ru.created_at, ru.updated_at,
              b.name AS branch_name
       FROM restaurant_users ru
       LEFT JOIN branches b ON b.id = ru.branch_id
       WHERE ru.restaurant_id = $1
       ORDER BY ru.created_at DESC`,
      [partnerId]
    );
    const normalizedRows = users.rows.map(r => {
      const isOwner = (r.role === 'owner' || (partner && (r.id === partner.id || r.auth_user_id === partner.id || (partner.email && r.email?.toLowerCase() === partner.email.toLowerCase()))));
      return {
        ...r,
        role: isOwner ? 'owner' : (r.role || 'staff'),
        permissions: isOwner ? ['*'] : (typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions),
      };
    });
    return res.json({
      success: true,
      data: normalizedRows,
      users: normalizedRows,
      count: normalizedRows.length,
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
  const { full_name, email, phone, password, role, branch_id, status, permissions } = req.body || {};

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
  if (password !== undefined && (typeof password !== 'string' || password.length < 6)) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.', code: 'INVALID_PASSWORD' });
  }

  const emailLower = email.trim().toLowerCase();
  const rawPassword = password ? String(password) : 'BhojMitra@123';

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
    const rawPlanName = String(sub?.plan_name || sub?.plan || 'trial').toLowerCase().trim();
    const planName = (rawPlanName === 'free trial' || rawPlanName === 'trial') ? 'trial' : rawPlanName;
    const defaultUsers = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : planName === 'trial' ? 2 : 2;
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

    // 5. Create or sync auth user in `users` table
    const passwordHash = await bcrypt.hash(rawPassword, 12);
    let authUserId: string;
    const existingAuthUser = await first('SELECT id FROM users WHERE LOWER(email) = $1', [emailLower]);
    if (existingAuthUser) {
      authUserId = existingAuthUser.id;
      if (password) {
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, authUserId]);
      }
    } else {
      authUserId = randomUUID();
      await db.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [authUserId, emailLower, passwordHash]);
    }

    const id = randomUUID();
    const userStatus = status || 'active';
    const userPermissions = Array.isArray(permissions) ? permissions : [];

    const user = await first(
      `INSERT INTO restaurant_users (id, restaurant_id, auth_user_id, full_name, email, phone, role, status, permissions, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [id, partnerId, authUserId, full_name.trim(), emailLower, phone ? String(phone).trim() : null, role.trim(), userStatus, JSON.stringify(userPermissions), branchIdValue]
    );

    logAdminActivity(partnerId, partnerId, full_name.trim(), 'Staff Added', 'user', id, `Staff member '${full_name.trim()}' (${role}) added`, req.ip);

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

    const { full_name, email, phone, password, role, branch_id, status, permissions } = req.body || {};

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

    // Password update handling
    if (password !== undefined && password !== null && String(password).trim()) {
      if (typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.', code: 'INVALID_PASSWORD' });
      }
      const newHash = await bcrypt.hash(password, 12);
      if (existing.auth_user_id) {
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, existing.auth_user_id]);
      } else {
        const existingAuth = await first('SELECT id FROM users WHERE LOWER(email) = $1', [updatedEmail]);
        if (existingAuth) {
          await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, existingAuth.id]);
          await db.query('UPDATE restaurant_users SET auth_user_id = $1 WHERE id = $2', [existingAuth.id, id]);
        } else {
          const newAuthId = randomUUID();
          await db.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [newAuthId, updatedEmail, newHash]);
          await db.query('UPDATE restaurant_users SET auth_user_id = $1 WHERE id = $2', [newAuthId, id]);
        }
      }
    }

    const partner = await first('SELECT id, email FROM partners WHERE id = $1', [partnerId]);
    const isTargetOwner = (existing.role === 'owner' || existing.id === partnerId || existing.auth_user_id === partnerId || (partner?.email && existing.email?.toLowerCase() === partner.email.toLowerCase()));

    const updatedPhone = phone !== undefined ? (phone ? String(phone).trim() : null) : existing.phone;
    let updatedRole = existing.role;
    if (role !== undefined) {
      const cleanRole = String(role).trim().toLowerCase();
      if (isTargetOwner) {
        updatedRole = 'owner';
      } else if (cleanRole === 'owner') {
        return res.status(400).json({ success: false, message: 'Owner role cannot be assigned to staff members.', code: 'INVALID_ROLE' });
      } else {
        updatedRole = cleanRole;
      }
    } else if (isTargetOwner) {
      updatedRole = 'owner';
    }

    const updatedStatus = status !== undefined ? String(status).trim() : existing.status;
    const updatedPermissions = isTargetOwner ? ['*'] : (permissions !== undefined ? (Array.isArray(permissions) ? permissions : existing.permissions) : existing.permissions);

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
    const rawPlanName = String(sub?.plan_name || sub?.plan || 'basic').toLowerCase().trim();
    const planName = (rawPlanName === 'free trial' || rawPlanName === 'trial') ? 'trial' : rawPlanName;
    const defaultBranches = planName === 'pro' ? 9999 : planName === 'basic' ? 5 : planName === 'starter' ? 3 : planName === 'trial' ? 1 : 1;
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

    logAdminActivity(partnerId, partnerId, manager_name || 'Owner', 'Branch Created', 'branch', id, `Branch '${name.trim()}' added (${city || 'India'})`, req.ip);

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

// ============================================================
// SUPER ADMIN PORTAL API ENDPOINTS
// ============================================================// 1. Dashboard Master KPIs & Charts
app.get('/api/admin/dashboard/stats', async (_req, res) => {
  try {
    const [
      kpiRes,
      planDistRes,
      recentRestos,
      recentPayments,
      recentActivityLogs,
      monthlySeriesRes,
      expiringRestos,
      openTicketsRes
    ] = await Promise.all([
      db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM partners) as total_restaurants,
          (SELECT COUNT(*)::int FROM partners WHERE status = 'active' OR onboarding_completed = true) as active_restaurants,
          (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'trial') as trial_restaurants,
          (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'expired') as expired,
          (SELECT COUNT(*)::int FROM partners WHERE status = 'suspended') as suspended,
          (SELECT COALESCE(SUM(COALESCE(s.amount, sp.price, 0)), 0)::numeric FROM subscriptions s LEFT JOIN subscription_plans sp ON LOWER(s.plan) = LOWER(sp.name) WHERE s.status IN ('active', 'trial')) as mrr,
          (SELECT COALESCE(SUM(total_amount), 0)::numeric FROM sales_orders WHERE created_at >= NOW() - INTERVAL '30 days') as monthly_revenue,
          (SELECT COALESCE(SUM(amount), 0)::numeric FROM invoices WHERE status = 'pending') as pending_payments
      `),
      db.query(`
        SELECT COALESCE(INITCAP(s.plan), 'Starter') as label, COUNT(*)::int as value
        FROM subscriptions s
        GROUP BY COALESCE(INITCAP(s.plan), 'Starter')
        ORDER BY value DESC
      `),
      db.query(`
        SELECT p.id, p.restaurant_name as name, p.owner_name as owner, p.email, p.phone,
               TO_CHAR(p.created_at, 'YYYY-MM-DD') as created,
               p.city, p.business_type as "businessType",
               COALESCE(p.status, 'active') as status,
               COALESCE(s.plan, 'Starter') as plan, COALESCE(s.status, 'active') as "subStatus"
        FROM partners p
        LEFT JOIN subscriptions s ON p.id = s.partner_id
        ORDER BY p.created_at DESC LIMIT 5
      `),
      db.query(`
        SELECT o.id, o.order_number as invoice, o.total_amount as amount, o.payment_mode as method,
               'Completed' as status, TO_CHAR(o.created_at, 'YYYY-MM-DD') as date, p.restaurant_name as restaurant
        FROM sales_orders o
        LEFT JOIN partners p ON o.restaurant_id = p.id
        ORDER BY o.created_at DESC LIMIT 5
      `),
      db.query(`
        SELECT a.id, COALESCE(p.restaurant_name, 'System') as restaurant,
               COALESCE(u.full_name, a.user_name, 'Admin') as user, a.action, a.description as detail,
               a.ip_address as ip,
               'Success' as status,
               TO_CHAR(a.created_at, 'YYYY-MM-DD HH24:MI') as timestamp,
               a.created_at as date
        FROM activity_logs a
        LEFT JOIN partners p ON a.restaurant_id = p.id
        LEFT JOIN restaurant_users u ON a.user_id = u.id
        ORDER BY a.created_at DESC LIMIT 6
      `),
      db.query(`
        WITH months AS (
          SELECT generate_series(
            DATE_TRUNC('month', NOW() - INTERVAL '5 months'),
            DATE_TRUNC('month', NOW()),
            '1 month'::interval
          ) as m
        )
        SELECT TO_CHAR(months.m, 'Mon') as label,
               COALESCE((SELECT COUNT(*)::int FROM partners WHERE DATE_TRUNC('month', created_at) = months.m), 0) as new_restaurants,
               COALESCE((SELECT SUM(total_amount)::numeric FROM sales_orders WHERE DATE_TRUNC('month', created_at) = months.m), 0) as sales,
               COALESCE((SELECT COUNT(*)::int FROM subscriptions WHERE created_at <= months.m + INTERVAL '1 month' AND status IN ('active', 'trial')), 0) as subs
        FROM months
        ORDER BY months.m ASC
      `),
      db.query(`
        SELECT p.id, p.restaurant_name as name, p.owner_name as owner, p.email,
               COALESCE(s.plan, 'Starter') as plan,
               TO_CHAR(s.expiry_date, 'YYYY-MM-DD') as "subExpiry",
               COALESCE(s.status, 'active') as "subStatus"
        FROM partners p
        JOIN subscriptions s ON p.id = s.partner_id
        WHERE s.expiry_date IS NOT NULL
        ORDER BY s.expiry_date ASC LIMIT 5
      `),
      db.query(`
        SELECT t.id, t.ticket_number as "ticketId", COALESCE(p.restaurant_name, 'Partner') as restaurant,
               t.subject, t.priority, t.status,
               TO_CHAR(t.created_at, 'YYYY-MM-DD') as created
        FROM support_tickets t
        LEFT JOIN partners p ON t.partner_id = p.id
        ORDER BY t.created_at DESC LIMIT 5
      `),
    ]);

    const kpi = kpiRes.rows[0] || {};
    const totalRestaurants = Number(kpi.total_restaurants || 0);
    const activeRestaurants = Number(kpi.active_restaurants || 0);
    const trialRestaurants = Number(kpi.trial_restaurants || 0);
    const expired = Number(kpi.expired || 0);
    const suspended = Number(kpi.suspended || 0);
    const mrr = Number(kpi.mrr || 0);
    const monthlyRevenue = Number(kpi.monthly_revenue || 0);
    const pendingPayments = Number(kpi.pending_payments || 0);

    const newRestaurantsSeries = monthlySeriesRes.rows.map(r => ({ label: r.label, value: Number(r.new_restaurants) }));
    const revenueSeries = monthlySeriesRes.rows.map(r => ({ label: r.label, value: Number(r.sales || 0) }));
    const subGrowthSeries = monthlySeriesRes.rows.map(r => ({ label: r.label, value: Number(r.subs) }));

    return res.json({
      success: true,
      data: {
        kpis: {
          totalRestaurants,
          activeRestaurants,
          trialRestaurants,
          expired,
          suspended,
          mrr,
          monthlyRevenue,
          pendingPayments,
        },
        planDistribution: planDistRes.rows.length > 0 ? planDistRes.rows.map((p, idx) => ({
          ...p,
          color: idx === 0 ? '#166534' : idx === 1 ? '#ea580c' : idx === 2 ? '#f59e0b' : '#10b981'
        })) : [
          { label: 'Starter', value: 0, color: '#166534' },
          { label: 'Growth', value: 0, color: '#ea580c' },
          { label: 'Pro', value: 0, color: '#f59e0b' },
        ],
        recentRestaurants: recentRestos.rows,
        recentPayments: recentPayments.rows,
        recentActivity: recentActivityLogs.rows,
        expiringRestaurants: expiringRestos.rows,
        openTickets: openTicketsRes.rows,
        revenueSeries,
        newRestaurantsSeries,
        subGrowthSeries,
      }
    });
  } catch (err: any) {
    console.error('Error in /api/admin/dashboard/stats:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 2. Restaurants Management
app.get('/api/admin/restaurants', async (req, res) => {
  try {
    const { search = '', status = 'all', page, limit } = req.query as any;
    
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (p.restaurant_name ILIKE $${params.length} OR p.owner_name ILIKE $${params.length} OR p.email ILIKE $${params.length} OR p.phone ILIKE $${params.length})`;
    }
    if (status !== 'all') {
      params.push(status);
      whereClause += ` AND LOWER(p.status) = LOWER($${params.length})`;
    }

    let paginationClause = '';
    if (limit && !isNaN(Number(limit))) {
      const pageNum = Math.max(1, Number(page) || 1);
      const limitNum = Math.min(1000, Math.max(1, Number(limit)));
      const offsetNum = (pageNum - 1) * limitNum;
      paginationClause = ` LIMIT ${limitNum} OFFSET ${offsetNum}`;
    }

    const query = `
      WITH branch_agg AS (
        SELECT restaurant_id, COUNT(*)::int as branches_count
        FROM branches GROUP BY restaurant_id
      ),
      user_agg AS (
        SELECT restaurant_id, COUNT(*)::int as users_count
        FROM restaurant_users GROUP BY restaurant_id
      ),
      gmv_agg AS (
        SELECT restaurant_id, COALESCE(SUM(total_amount), 0)::numeric as total_gmv
        FROM sales_orders GROUP BY restaurant_id
      )
      SELECT p.id, p.restaurant_name as name, p.owner_name as owner, p.email, p.phone,
             p.city, COALESCE(p.city, 'India') as address, p.gst_number, p.business_type as "businessType",
             COALESCE(p.status, 'active') as status,
             TO_CHAR(p.created_at, 'YYYY-MM-DD') as created,
             COALESCE(s.plan, 'Starter') as plan,
             COALESCE(s.status, 'active') as "subStatus",
             TO_CHAR(s.expiry_date, 'YYYY-MM-DD') as "subExpiry",
             COALESCE(b.branches_count, 0) as branches,
             COALESCE(u.users_count, 0) as users,
             COALESCE(g.total_gmv, 0) as total_gmv
      FROM partners p
      LEFT JOIN subscriptions s ON p.id = s.partner_id
      LEFT JOIN branch_agg b ON b.restaurant_id = p.id
      LEFT JOIN user_agg u ON u.restaurant_id = p.id
      LEFT JOIN gmv_agg g ON g.restaurant_id = p.id
      ${whereClause}
      ORDER BY p.created_at DESC
      ${paginationClause}
    `;

    const r = await db.query(query, params);
    return res.json({ success: true, data: r.rows });
  } catch (err: any) {
    console.error('Error in /api/admin/restaurants:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Single Restaurant Profile & Detailed Stats
app.get('/api/admin/restaurants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const partner = await first(`
      SELECT p.id, p.restaurant_name as name, p.owner_name as owner, p.email, p.phone,
             p.city, COALESCE(p.city, 'India') as address, p.gst_number, p.business_type as "businessType",
             COALESCE(p.status, 'active') as status,
             TO_CHAR(p.created_at, 'YYYY-MM-DD') as created,
             COALESCE(s.plan, 'Starter') as plan,
             COALESCE(s.status, 'active') as "subStatus",
             TO_CHAR(s.start_date, 'YYYY-MM-DD') as "subStartDate",
             TO_CHAR(s.expiry_date, 'YYYY-MM-DD') as "subExpiry",
             COALESCE(s.amount, 799) as "subAmount",
             COALESCE(s.billing_cycle, 'Monthly') as "subCycle",
             COALESCE(s.auto_renew, true) as "subAutoRenew"
      FROM partners p
      LEFT JOIN subscriptions s ON p.id = s.partner_id
      WHERE p.id = $1
    `, [id]);
    if (!partner) return res.status(404).json({ error: 'Restaurant not found' });

    const [branches, users, orders, logs, tickets, counts] = await Promise.all([
      db.query(`
        SELECT b.id, b.name, b.code, b.city, b.state, b.phone, b.manager_name as manager,
               COALESCE(b.status, 'Active') as status,
               (SELECT COUNT(*) FROM restaurant_users u WHERE u.branch_id = b.id)::int as users,
               (SELECT COUNT(*) FROM inventory_items i WHERE i.branch_id = b.id)::int as "inventoryItems"
        FROM branches b
        WHERE b.restaurant_id = $1
        ORDER BY b.created_at DESC
      `, [id]),
      db.query(`
        SELECT u.id, u.full_name as name, u.email, u.phone, u.role,
               COALESCE(u.status, 'Active') as status,
               TO_CHAR(u.created_at, 'YYYY-MM-DD') as created
        FROM restaurant_users u
        WHERE u.restaurant_id = $1
        ORDER BY u.created_at DESC
      `, [id]),
      db.query(`
        SELECT o.id, o.order_number as invoice, o.total_amount as amount,
               o.payment_mode as method, 'Completed' as status,
               TO_CHAR(o.created_at, 'YYYY-MM-DD') as date
        FROM sales_orders o
        WHERE o.restaurant_id = $1
        ORDER BY o.created_at DESC LIMIT 20
      `, [id]),
      db.query(`
        SELECT a.id, a.user_name as user, a.action, a.description as detail,
               a.ip_address as ip, 'Success' as status,
               TO_CHAR(a.created_at, 'YYYY-MM-DD HH24:MI') as timestamp,
               a.created_at as date
        FROM activity_logs a
        WHERE a.restaurant_id = $1
        ORDER BY a.created_at DESC LIMIT 20
      `, [id]),
      db.query(`
        SELECT t.id, t.ticket_number as "ticketId", t.subject, t.priority, t.status,
               TO_CHAR(t.created_at, 'YYYY-MM-DD') as created
        FROM support_tickets t
        WHERE t.partner_id = $1
        ORDER BY t.created_at DESC LIMIT 10
      `, [id]),
      db.query(`
        SELECT (SELECT COUNT(*) FROM inventory_items WHERE restaurant_id = $1)::int as inventory_count,
               (SELECT COUNT(*) FROM dining_tables WHERE restaurant_id = $1)::int as table_count,
               (SELECT COALESCE(SUM(total_amount), 0) FROM sales_orders WHERE restaurant_id = $1)::numeric as total_gmv,
               (SELECT COUNT(*) FROM sales_orders WHERE restaurant_id = $1)::int as total_orders
      `, [id]),
    ]);

    return res.json({
      success: true,
      data: {
        restaurant: partner,
        branches: branches.rows,
        users: users.rows,
        payments: orders.rows,
        activityLogs: logs.rows,
        tickets: tickets.rows,
        stats: counts.rows[0] || {},
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Create Restaurant from Super Admin
app.post('/api/admin/restaurants', async (req, res) => {
  const { name, owner, email, phone, city, cuisine = 'restaurant', plan = 'Growth', branches = 1 } = req.body;
  if (!name || !owner || !email) {
    return res.status(400).json({ error: 'Name, owner, and email are required' });
  }
  try {
    const id = randomUUID();
    const emailLower = String(email).trim().toLowerCase();
    const hash = await bcrypt.hash('Password123!', 10);
    await db.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [id, emailLower, hash]);
    await db.query(
      `INSERT INTO partners (id, owner_name, restaurant_name, email, phone, city, business_type, status, onboarding_completed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', true)`,
      [id, owner.trim(), name.trim(), emailLower, phone ? String(phone).trim() : null, city || 'India', cuisine?.toLowerCase() || 'restaurant']
    );
    const mainBranchId = randomUUID();
    await db.query(
      `INSERT INTO branches (id, restaurant_id, name, code, city, status)
       VALUES ($1, $2, 'Main Branch', 'MAIN', $3, 'active')`,
      [mainBranchId, id, city || 'India']
    );
    await db.query(
      `INSERT INTO restaurant_users (id, restaurant_id, auth_user_id, full_name, email, phone, role, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'owner', 'active')`,
      [id, id, id, owner.trim(), emailLower, phone ? String(phone).trim() : null]
    );
    await db.query(
      `INSERT INTO subscriptions (id, partner_id, plan, billing_cycle, status, start_date, expiry_date, auto_renew, amount)
       VALUES ($1, $2, $3, 'monthly', 'active', NOW(), NOW() + INTERVAL '30 days', TRUE, $4)`,
      [randomUUID(), id, plan.toLowerCase(), plan.toLowerCase() === 'pro' ? 2999 : plan.toLowerCase() === 'starter' ? 799 : 1499]
    );
    logAdminActivity(id, id, owner.trim(), 'Restaurant Registered', 'partner', id, `New restaurant '${name.trim()}' added via Super Admin`, req.ip);
    return res.status(201).json({ success: true, message: 'Restaurant created successfully', id });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 3. Toggle Restaurant Status
app.patch('/api/admin/restaurants/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const normalizedStatus = String(status || 'active').toLowerCase() === 'suspended' ? 'suspended' : 'active';
    await db.query('UPDATE partners SET status = $1, updated_at = NOW() WHERE id = $2', [normalizedStatus, id]);
    await db.query('UPDATE restaurant_users SET status = $1, updated_at = NOW() WHERE restaurant_id = $2', [normalizedStatus, id]);
    if (normalizedStatus === 'suspended') {
      await db.query('UPDATE subscriptions SET status = $1 WHERE partner_id = $2', ['suspended', id]);
    } else {
      await db.query('UPDATE subscriptions SET status = $1 WHERE partner_id = $2 AND status = $3', ['active', id, 'suspended']);
    }
    await logAdminActivity(id, id, 'Super Admin', 'Restaurant Status Updated', 'partner', id, `Restaurant #${id.slice(0, 8)} status set to ${normalizedStatus}`, req.ip);
    return res.json({ success: true, message: `Restaurant status updated to ${normalizedStatus}` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 4. Subscriptions List
app.get('/api/admin/subscriptions', async (req, res) => {
  try {
    const { page, limit } = req.query as any;
    let paginationClause = '';
    if (limit && !isNaN(Number(limit))) {
      const pageNum = Math.max(1, Number(page) || 1);
      const limitNum = Math.min(1000, Math.max(1, Number(limit)));
      const offsetNum = (pageNum - 1) * limitNum;
      paginationClause = ` LIMIT ${limitNum} OFFSET ${offsetNum}`;
    }

    const r = await db.query(`
      WITH branch_agg AS (
        SELECT restaurant_id, COUNT(*)::int as branches_count
        FROM branches GROUP BY restaurant_id
      ),
      user_agg AS (
        SELECT restaurant_id, COUNT(*)::int as users_count
        FROM restaurant_users GROUP BY restaurant_id
      )
      SELECT s.id, s.partner_id as "restaurantId", p.restaurant_name as "restaurantName",
             p.email, COALESCE(s.plan, 'Starter') as plan,
             COALESCE(s.status, 'active') as status,
             TO_CHAR(s.start_date, 'YYYY-MM-DD') as "startDate",
             TO_CHAR(s.expiry_date, 'YYYY-MM-DD') as "expiryDate",
             s.auto_renew as "autoRenew",
             COALESCE(b.branches_count, 0) as "branchesCount",
             COALESCE(u.users_count, 0) as "usersCount"
      FROM subscriptions s
      JOIN partners p ON s.partner_id = p.id
      LEFT JOIN branch_agg b ON b.restaurant_id = p.id
      LEFT JOIN user_agg u ON u.restaurant_id = p.id
      ORDER BY s.created_at DESC
      ${paginationClause}
    `);
    return res.json({ success: true, data: r.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 5. Plans
app.get('/api/admin/plans', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT sp.*, 
             (SELECT COUNT(*)::int FROM subscriptions s WHERE LOWER(s.plan) = LOWER(sp.name)) as "restaurantsCount"
      FROM subscription_plans sp 
      ORDER BY sp.id ASC
    `);
    return res.json({ success: true, data: r.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 6. Payments
app.get('/api/admin/payments', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT o.id, o.order_number as invoice, p.restaurant_name as "restaurantName",
             o.total_amount as amount, o.payment_mode as method, 'Completed' as status,
             TO_CHAR(o.created_at, 'YYYY-MM-DD') as date
      FROM sales_orders o
      LEFT JOIN partners p ON o.restaurant_id = p.id
      ORDER BY o.created_at DESC LIMIT 50
    `);
    return res.json({ success: true, data: r.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 7. Invoices
app.get('/api/admin/invoices', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT o.id, o.order_number as "invoiceNumber", p.restaurant_name as "restaurantName",
             p.email as "customerEmail", o.total_amount as amount,
             TO_CHAR(o.created_at, 'YYYY-MM-DD') as "issueDate",
             TO_CHAR(o.created_at + INTERVAL '30 days', 'YYYY-MM-DD') as "dueDate",
             'Paid' as status
      FROM sales_orders o
      LEFT JOIN partners p ON o.restaurant_id = p.id
      ORDER BY o.created_at DESC LIMIT 50
    `);
    return res.json({ success: true, data: r.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 8. Users List & Status
app.get('/api/admin/users', async (req, res) => {
  try {
    const { page, limit } = req.query as any;
    let paginationClause = '';
    if (limit && !isNaN(Number(limit))) {
      const pageNum = Math.max(1, Number(page) || 1);
      const limitNum = Math.min(1000, Math.max(1, Number(limit)));
      const offsetNum = (pageNum - 1) * limitNum;
      paginationClause = ` LIMIT ${limitNum} OFFSET ${offsetNum}`;
    }

    const r = await db.query(`
      SELECT u.id, u.full_name as name, u.email, u.phone, u.role,
             p.restaurant_name as "restaurantName",
             TO_CHAR(u.created_at, 'YYYY-MM-DD') as created,
             COALESCE(u.status, p.status, 'active') as status
      FROM restaurant_users u
      LEFT JOIN partners p ON u.restaurant_id = p.id
      ORDER BY u.created_at DESC
      ${paginationClause}
    `);
    return res.json({ success: true, data: r.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const normalizedStatus = String(status || 'active').toLowerCase() === 'suspended' ? 'suspended' : 'active';
    
    // 1. Update restaurant_users
    await db.query('UPDATE restaurant_users SET status = $1, updated_at = NOW() WHERE id = $2 OR auth_user_id = $2', [normalizedStatus, id]);
    
    // 2. Update partners if this user is a partner
    await db.query('UPDATE partners SET status = $1, updated_at = NOW() WHERE id = $2', [normalizedStatus, id]);

    // 3. Update subscriptions
    if (normalizedStatus === 'suspended') {
      await db.query('UPDATE subscriptions SET status = $1 WHERE partner_id = $2', ['suspended', id]);
    } else {
      await db.query('UPDATE subscriptions SET status = $1 WHERE partner_id = $2 AND status = $3', ['active', id, 'suspended']);
    }

    await logAdminActivity(id, id, 'Super Admin', 'User Status Updated', 'users', id, `User #${id.slice(0, 8)} status set to ${normalizedStatus}`, req.ip);

    return res.json({ success: true, message: `User status updated to ${normalizedStatus}` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 9. Branches
app.get('/api/admin/branches', async (req, res) => {
  try {
    const { page, limit } = req.query as any;
    let paginationClause = '';
    if (limit && !isNaN(Number(limit))) {
      const pageNum = Math.max(1, Number(page) || 1);
      const limitNum = Math.min(1000, Math.max(1, Number(limit)));
      const offsetNum = (pageNum - 1) * limitNum;
      paginationClause = ` LIMIT ${limitNum} OFFSET ${offsetNum}`;
    }

    const r = await db.query(`
      WITH branch_users AS (
        SELECT branch_id, COUNT(*)::int as users_count
        FROM restaurant_users WHERE branch_id IS NOT NULL GROUP BY branch_id
      ),
      branch_inv AS (
        SELECT branch_id, COUNT(*)::int as items_count
        FROM inventory_items WHERE branch_id IS NOT NULL GROUP BY branch_id
      )
      SELECT b.id, b.name, b.code, b.city, b.state, b.phone, b.manager_name as manager,
             p.restaurant_name as "restaurantName",
             COALESCE(bu.users_count, 0) as users,
             COALESCE(bi.items_count, 0) as "inventoryItems",
             TO_CHAR(b.created_at, 'YYYY-MM-DD') as created,
             COALESCE(b.status, 'Active') as status
      FROM branches b
      LEFT JOIN partners p ON b.restaurant_id = p.id
      LEFT JOIN branch_users bu ON bu.branch_id = b.id
      LEFT JOIN branch_inv bi ON bi.branch_id = b.id
      ORDER BY b.created_at DESC
      ${paginationClause}
    `);
    return res.json({ success: true, data: r.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 10. Activity Logs
app.get('/api/admin/activity-logs', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT a.id, COALESCE(p.restaurant_name, 'System') as restaurant,
             COALESCE(u.full_name, 'Admin') as user, a.action, a.description as detail,
             a.ip_address as ip,
             TO_CHAR(a.created_at, 'YYYY-MM-DD HH24:MI') as timestamp
      FROM activity_logs a
      LEFT JOIN partners p ON a.restaurant_id = p.id
      LEFT JOIN restaurant_users u ON a.user_id = u.id
      ORDER BY a.created_at DESC LIMIT 50
    `);
    return res.json({ success: true, data: r.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 11. Support Tickets
app.get('/api/admin/support-tickets', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT t.id, t.ticket_number as "ticketId", p.restaurant_name as restaurant,
             t.subject, t.priority, t.status,
             TO_CHAR(t.created_at, 'YYYY-MM-DD') as created,
             TO_CHAR(t.updated_at, 'YYYY-MM-DD') as updated
      FROM support_tickets t
      LEFT JOIN partners p ON t.partner_id = p.id
      ORDER BY t.created_at DESC LIMIT 50
    `);
    return res.json({ success: true, data: r.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 12. Admin Leads (Demo requests & contact queries)
app.get('/api/admin/leads', async (_req, res) => {
  try {
    const [demosRes, contactsRes] = await Promise.all([
      db.query(`
        SELECT id, name, restaurant_name as "restaurantName", email, phone, city,
               number_of_branches as "branches", preferred_date as "preferredDate",
               preferred_time as "preferredTime", message, reference_id as "referenceId",
               COALESCE(status, 'new') as status, 'demo' as type,
               TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') as "createdFormatted",
               created_at as created
        FROM demo_requests
        ORDER BY created_at DESC
      `),
      db.query(`
        SELECT id, name, subject as "restaurantName", email, phone, 'India' as city,
               1 as "branches", NULL as "preferredDate", NULL as "preferredTime",
               message, reference_id as "referenceId",
               COALESCE(status, 'new') as status, 'contact' as type,
               TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') as "createdFormatted",
               created_at as created
        FROM contact_queries
        ORDER BY created_at DESC
      `),
    ]);

    const allLeads = [...demosRes.rows, ...contactsRes.rows].sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

    const counts = {
      total: allLeads.length,
      new: allLeads.filter(l => l.status === 'new' || !l.status).length,
      contacted: allLeads.filter(l => l.status === 'contacted').length,
      converted: allLeads.filter(l => l.status === 'converted').length,
      closed: allLeads.filter(l => l.status === 'closed' || l.status === 'rejected').length,
    };

    return res.json({ success: true, data: allLeads, counts });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Update Lead Status
app.patch('/api/admin/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, type } = req.body;
    const validStatuses = ['new', 'contacted', 'converted', 'closed', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (type === 'contact') {
      await db.query('UPDATE contact_queries SET status = $1 WHERE id = $2', [status, id]);
    } else {
      await db.query('UPDATE demo_requests SET status = $1 WHERE id = $2', [status, id]);
    }

    await logActivity(null, null, 'Super Admin', 'Lead Status Updated', 'leads', id, `Lead #${id.slice(0, 8)} updated to ${status}`);

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 13. Admin Website Visitors & Live Presence
app.get('/api/admin/website/visitors', async (_req, res) => {
  try {
    const [onlineRes, todayRes, totalRes, avgTimeRes, topPagesRes, streamRes] = await Promise.all([
      db.query(`SELECT COUNT(*)::int as count FROM website_visitors WHERE is_online = TRUE AND last_heartbeat >= NOW() - INTERVAL '60 seconds'`),
      db.query(`SELECT COUNT(*)::int as count FROM website_visitors WHERE created_at >= CURRENT_DATE`),
      db.query(`SELECT COUNT(*)::int as count FROM website_visitors`),
      db.query(`SELECT COALESCE(AVG(time_spent_seconds), 0)::int as avg_seconds FROM website_visitors`),
      db.query(`
        SELECT current_page as page, COUNT(*)::int as visits
        FROM website_visitors
        GROUP BY current_page
        ORDER BY visits DESC LIMIT 6
      `),
      db.query(`
        SELECT id, session_id as "sessionId", ip_address as ip, device_type as "deviceType",
               browser, os, city, country, referrer, landing_page as "landingPage",
               current_page as "currentPage", time_spent_seconds as "timeSpentSeconds",
               (is_online = TRUE AND last_heartbeat >= NOW() - INTERVAL '60 seconds') as "isOnline",
               TO_CHAR(last_heartbeat, 'YYYY-MM-DD HH24:MI:SS') as "lastHeartbeat",
               TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI') as created
        FROM website_visitors
        ORDER BY last_heartbeat DESC LIMIT 50
      `),
    ]);

    const onlineNow = onlineRes.rows[0]?.count || 0;
    const totalToday = todayRes.rows[0]?.count || 0;
    const totalVisits = totalRes.rows[0]?.count || 0;
    const avgTimeSpent = avgTimeRes.rows[0]?.avg_seconds || 0;
    const topPages = topPagesRes.rows || [];
    const recentVisitors = streamRes.rows || [];

    return res.json({
      success: true,
      data: {
        onlineNow,
        totalToday,
        totalVisits,
        avgTimeSpent,
        topPages,
        recentVisitors,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/public/menu/:restaurantId (Customer QR Menu API - No Auth Required)
app.get('/api/public/menu/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    let partner = await first(
      `SELECT id, restaurant_name, business_name, owner_name, email, phone, city, business_type, gst_number FROM partners WHERE id = $1`,
      [restaurantId]
    );

    if (!partner) {
      partner = await first(`SELECT id, restaurant_name, business_name, owner_name, email, phone, city, business_type, gst_number FROM partners ORDER BY created_at DESC LIMIT 1`);
    }

    if (!partner) {
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }

    const [itemsRes, tablesRes] = await Promise.all([
      db.query(
        `SELECT id, name, category, description, selling_price, is_vegetarian, is_available, status, food_cost
         FROM menu_items
         WHERE restaurant_id = $1 AND (status = 'active' OR status IS NULL)
         ORDER BY category ASC, name ASC`,
        [partner.id]
      ),
      db.query(
        `SELECT id, table_number, name, section, seating_capacity, status
         FROM dining_tables
         WHERE restaurant_id = $1
         ORDER BY table_number ASC`,
        [partner.id]
      ),
    ]);

    const items = itemsRes.rows;
    const tables = tablesRes.rows;
    const categories = Array.from(new Set(items.map((i: any) => i.category).filter(Boolean)));

    return res.json({
      success: true,
      restaurant: {
        id: partner.id,
        name: partner.restaurant_name || partner.business_name || 'BhojMitra Dining',
        legal_name: partner.business_name || partner.restaurant_name,
        phone: partner.phone || '6388433679',
        email: partner.email,
        city: partner.city || 'Noida',
        address: partner.city ? `${partner.city}, India` : 'Commercial Hub, India',
        business_type: partner.business_type || 'restaurant',
        gst_number: partner.gst_number || '07AAAAA0000A1Z5',
      },
      categories,
      tables,
      items,
    });
  } catch (err: any) {
    console.error('Error fetching public menu:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to fetch public menu' });
  }
});

// POST /api/public/orders/place (Customer QR Table Order - No Auth Required)
app.post('/api/public/orders/place', async (req, res) => {
  try {
    const { restaurant_id, table_number, customer_name, customer_phone, items, notes, order_type } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid order payload: items list is required' });
    }

    // Resolve partner
    let partner = await first(
      `SELECT id, restaurant_name, business_name FROM partners WHERE id = $1`,
      [restaurant_id]
    );

    if (!partner) {
      partner = await first(`SELECT id, restaurant_name, business_name FROM partners ORDER BY created_at DESC LIMIT 1`);
    }

    if (!partner) {
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }

    const partnerId = partner.id;

    // Find table if provided
    let tableRow = null;
    if (table_number) {
      const tableQuery = await db.query(
        `SELECT id, table_number, name, section FROM dining_tables 
         WHERE restaurant_id = $1 AND (table_number = $2 OR name ILIKE $3 OR table_number ILIKE $3) LIMIT 1`,
        [partnerId, table_number, `%${table_number}%`]
      );
      if (tableQuery.rows.length > 0) {
        tableRow = tableQuery.rows[0];
      }
    }

    const orderId = randomUUID();
    const kotId = randomUUID();
    const orderNum = `ORD-${Date.now().toString().slice(-4)}`;
    const kotNumber = `KOT-${Date.now().toString().slice(-4)}`;
    
    const subtotal = items.reduce((sum: number, it: any) => {
      const p = Number(it.price || it.selling_price || 0);
      const q = Number(it.quantity || 1);
      return sum + (p * q);
    }, 0);
    const taxAmount = Math.round((subtotal * 0.05) * 100) / 100;
    const grandTotal = subtotal + taxAmount;
    const finalTableName = tableRow ? tableRow.name : (table_number ? `Table ${table_number}` : 'Table Order');
    const finalTableNum = tableRow ? tableRow.table_number : (table_number || 'T1');

    // 1. Insert sales_orders
    await db.query(
      `INSERT INTO sales_orders (
        id, restaurant_id, table_id, table_name, order_number, order_type, customer_name, customer_phone,
        subtotal, tax_amount, tax_percent, total_amount, payment_mode, payment_status, notes, status, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 5, $11, 'pending', 'unpaid', $12, 'pending', NOW(), NOW()
      )`,
      [
        orderId,
        partnerId,
        tableRow ? tableRow.id : null,
        finalTableName,
        orderNum,
        order_type || 'dine_in',
        customer_name || `${finalTableName} Guest`,
        customer_phone || null,
        subtotal,
        taxAmount,
        grandTotal,
        `[Customer QR Table Order - ${finalTableName}] ${notes || ''}`
      ]
    );

    // 2. Insert sales_order_items
    for (const itm of items) {
      const itmId = randomUUID();
      const qty = Number(itm.quantity || 1);
      const rate = Number(itm.price || itm.selling_price || 0);
      const lineTotal = rate * qty;

      let validMenuItemId: string | null = null;
      const targetId = itm.id || itm.menu_item_id;
      if (targetId) {
        const check = await db.query('SELECT id FROM menu_items WHERE id = $1 AND restaurant_id = $2 LIMIT 1', [targetId, partnerId]);
        if (check.rows.length > 0) {
          validMenuItemId = check.rows[0].id;
        }
      }

      await db.query(
        `INSERT INTO sales_order_items
         (id, sales_order_id, restaurant_id, menu_item_id, item_name, quantity, unit_price, tax_percent, total_price, notes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 5, $8, $9, NOW())`,
        [
          itmId,
          orderId,
          partnerId,
          validMenuItemId,
          itm.name || itm.item_name || 'Dish Item',
          qty,
          rate,
          lineTotal,
          itm.notes || null,
        ]
      );
    }

    // 3. Insert KOT Ticket
    await db.query(
      `INSERT INTO kot_tickets
       (id, restaurant_id, table_id, table_number, table_name, sales_order_id, kot_number, order_type, server_name, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, NOW(), NOW())`,
      [
        kotId,
        partnerId,
        tableRow ? tableRow.id : null,
        finalTableNum,
        finalTableName,
        orderId,
        kotNumber,
        'dine_in',
        'Customer QR Order',
        `[QR Order] ${notes || 'Freshly ordered from table'}`,
      ]
    );

    // 4. Insert KOT Items
    for (const itm of items) {
      await db.query(
        `INSERT INTO kot_items (id, kot_id, restaurant_id, item_name, quantity, unit, notes, status)
         VALUES ($1, $2, $3, $4, $5, 'portion', $6, 'pending')`,
        [
          randomUUID(),
          kotId,
          partnerId,
          itm.name || itm.item_name || 'Dish Item',
          Number(itm.quantity || 1),
          itm.notes || null,
        ]
      );
    }

    // 5. Update Dining Table status to occupied
    if (tableRow) {
      await db.query(
        `UPDATE dining_tables SET status = 'occupied', current_order_id = $1, updated_at = NOW() WHERE id = $2`,
        [orderId, tableRow.id]
      );
    }

    // 6. Insert live notification for partner
    await db.query(
      `INSERT INTO notifications (id, restaurant_id, partner_id, type, title, message, is_read, link, created_at, updated_at)
       VALUES ($1, $2, $3, 'order', $4, $5, false, '/kot', NOW(), NOW())`,
      [
        randomUUID(),
        partnerId,
        partnerId,
        `🛎️ New Table Order: ${finalTableName}`,
        `${customer_name || 'Guest'} at ${finalTableName} ordered ${items.length} dishes (₹${grandTotal.toFixed(2)}).`,
      ]
    );

    return res.json({
      success: true,
      message: `Order #${orderNum} received! Sent to kitchen.`,
      order_id: orderId,
      order_number: orderNum,
      kot_number: kotNumber,
      table_number: finalTableNum,
      table_name: finalTableName,
      subtotal,
      tax_amount: taxAmount,
      grand_total: grandTotal,
      item_count: items.length,
    });
  } catch (err: any) {
    console.error('Error placing public table order:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to place table order' });
  }
});

initDatabase().then(() => {
	app.listen(config.port, () => console.log(`BhojMitra backend listening on http://localhost:${config.port}`));
}).catch((error) => {
	console.error('Unable to initialize PostgreSQL:', error);
	process.exit(1);
});

