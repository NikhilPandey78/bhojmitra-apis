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

app.get('/health', async (_req, res) => { try { await db.query('SELECT 1'); res.json({ status: 'ok', database: 'postgresql' }); } catch { res.status(503).json({ status: 'error' }); } });
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
]);
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
]);

app.get('/api/resto/:table', requireAuth, async (req: AuthenticatedRequest, res) => {
  const table = String(req.params.table || '');
  const partnerId = req.userId;
  if (!partnerId) return res.status(401).json({ error: 'Unauthorized' });
  if (!ALLOWED_RESTO_TABLES.has(table)) {
    return res.status(400).json({ error: `Unknown resource: ${table}` });
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
    const [branches, items] = await Promise.all([
      db.query('SELECT * FROM branches WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM stock_transfer_items WHERE restaurant_id = $1', [partnerId]),
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
    const [supps, items] = await Promise.all([
      db.query('SELECT * FROM suppliers WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM purchase_order_items WHERE restaurant_id = $1', [partnerId]),
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
    const [supps, items] = await Promise.all([
      db.query('SELECT * FROM suppliers WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM stock_receipt_items WHERE restaurant_id = $1', [partnerId]),
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
    const [supps, items] = await Promise.all([
      db.query('SELECT * FROM suppliers WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM purchase_return_items WHERE restaurant_id = $1', [partnerId]),
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
    const items = await db.query('SELECT * FROM stock_adjustment_items WHERE restaurant_id = $1', [partnerId]);
    const itemsByAdj: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByAdj[it.stock_adjustment_id]) itemsByAdj[it.stock_adjustment_id] = [];
      itemsByAdj[it.stock_adjustment_id].push(it);
    }
    for (const row of rows) {
      row.items = itemsByAdj[row.id] || [];
    }
  } else if (table === 'stock_counts' && rows.length > 0) {
    const [branches, items] = await Promise.all([
      db.query('SELECT * FROM branches WHERE restaurant_id = $1', [partnerId]),
      db.query('SELECT * FROM stock_count_items WHERE restaurant_id = $1', [partnerId]),
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
    const items = await db.query('SELECT * FROM stock_issue_items WHERE restaurant_id = $1', [partnerId]);
    const itemsByIssue: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByIssue[it.stock_issue_id]) itemsByIssue[it.stock_issue_id] = [];
      itemsByIssue[it.stock_issue_id].push(it);
    }
    for (const row of rows) {
      row.items = itemsByIssue[row.id] || [];
    }
  } else if (table === 'kitchen_requisitions' && rows.length > 0) {
    const items = await db.query('SELECT * FROM kitchen_requisition_items WHERE restaurant_id = $1', [partnerId]);
    const itemsByReq: Record<string, any[]> = {};
    for (const it of items.rows) {
      if (!itemsByReq[it.kitchen_requisition_id]) itemsByReq[it.kitchen_requisition_id] = [];
      itemsByReq[it.kitchen_requisition_id].push(it);
    }
    for (const row of rows) {
      row.items = itemsByReq[row.id] || [];
    }
  } else if (table === 'recipes' && rows.length > 0) {
    const ingredients = await db.query('SELECT * FROM recipe_ingredients WHERE restaurant_id = $1', [partnerId]);
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
  }

    return res.json({ data: rows });
  } catch (err: any) {
    console.error(`Error in GET /api/resto/${table}:`, err);
    return res.status(500).json({ error: err?.message || 'Database error occurred while fetching records' });
  }
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
  } = req.body || {};

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one order item is required.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Generate Order & KOT Numbers
    const countRes = await client.query('SELECT COUNT(*) FROM sales_orders WHERE restaurant_id = $1', [partnerId]);
    const orderCount = parseInt(countRes.rows[0].count, 10) + 1;
    const orderNumber = `ORD-${String(orderCount).padStart(4, '0')}`;
    const kotNumber = `KOT-${String(orderCount).padStart(4, '0')}`;
    const orderId = randomUUID();
    const kotId = randomUUID();

    // 2. Fetch table details if table_id is provided
    let tableNumber = null;
    if (table_id) {
      const tableRow = (await client.query('SELECT * FROM dining_tables WHERE id = $1 AND restaurant_id = $2', [table_id, partnerId])).rows[0];
      if (tableRow) {
        tableNumber = tableRow.table_number || tableRow.name;
        await client.query(
          `UPDATE dining_tables SET status = $1, current_order_id = $2, updated_at = NOW() WHERE id = $3`,
          [payment_status === 'paid' ? 'available' : 'occupied', payment_status === 'paid' ? null : orderId, table_id]
        );
      }
    }

    // 3. Insert sales_orders
    const orderRow = (
      await client.query(
        `INSERT INTO sales_orders
         (id, restaurant_id, branch_id, table_id, order_number, order_type, customer_name, customer_phone, subtotal, discount_amount, discount_percent, tax_amount, tax_percent, total_amount, payment_status, payment_mode, status, notes, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'completed', $17, $18, NOW(), NOW())
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
          payment_status,
          payment_mode,
          notes,
          partnerId,
        ]
      )
    ).rows[0];

    // 4. Insert sales_order_items & deduction from inventory if linked
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

      // If direct inventory item is linked, deduct stock and record stock_transaction
      if (itm.item_id) {
        const invRow = (await client.query('SELECT current_stock FROM inventory_items WHERE id = $1 AND restaurant_id = $2', [itm.item_id, partnerId])).rows[0];
        if (invRow) {
          const current = Number(invRow.current_stock || 0);
          const newQty = Math.max(0, current - qty);
          await client.query('UPDATE inventory_items SET current_stock = $1, updated_at = NOW() WHERE id = $2', [newQty, itm.item_id]);
          await client.query(
            `INSERT INTO stock_transactions
             (id, restaurant_id, branch_id, item_id, transaction_type, quantity_change, quantity_after, reference_type, reference_id, unit_cost, notes)
             VALUES ($1, $2, $3, $4, 'sales', $5, $6, 'sales_order', $7, $8, $9)`,
            [randomUUID(), partnerId, branch_id, itm.item_id, -qty, newQty, orderId, rate, `POS Sale ${orderNumber}`]
          );
        }
      }
    }

    // 5. Create KOT Ticket for kitchen display
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
          'POS Counter',
          notes,
        ]
      )
    ).rows[0];

    // Insert KOT Items
    for (const itm of items) {
      await client.query(
        `INSERT INTO kot_items (id, kot_id, restaurant_id, item_name, quantity, unit, notes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
        [
          randomUUID(),
          kotId,
          partnerId,
          itm.item_name || itm.name || 'Item',
          Number(itm.quantity || 1),
          itm.unit || 'portion',
          itm.notes || null,
        ]
      );
    }

    // 6. Update Customer Spend if customer_name or phone is provided
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

    // 7. If payment_mode is 'khata', record transaction in customer_khata ledger
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

    // 8. Activity log for Super Admin
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
        `POS Order #${orderNumber} placed for ₹${Number(total_amount).toLocaleString('en-IN')} (${payment_mode})`,
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
// ============================================================

// 1. Dashboard Master KPIs & Charts
app.get('/api/admin/dashboard/stats', async (_req, res) => {
  try {
    const totalRestoRes = await db.query('SELECT COUNT(*) FROM partners');
    const activeRestoRes = await db.query("SELECT COUNT(*) FROM partners WHERE status = 'active' OR onboarding_completed = true");
    const trialSubRes = await db.query("SELECT COUNT(*) FROM subscriptions WHERE status = 'trial'");
    const expiredSubRes = await db.query("SELECT COUNT(*) FROM subscriptions WHERE status = 'expired'");
    const suspendedRes = await db.query("SELECT COUNT(*) FROM partners WHERE status = 'suspended'");
    
    // Revenue from active subscriptions
    const subRevRes = await db.query(`
      SELECT COALESCE(SUM(COALESCE(s.amount, sp.price, 0)), 0)::numeric as mrr 
      FROM subscriptions s 
      LEFT JOIN subscription_plans sp ON LOWER(s.plan) = LOWER(sp.name) 
      WHERE s.status IN ('active', 'trial')
    `);
    
    // Total platform GMV from sales_orders
    const ordersRes = await db.query("SELECT COUNT(*) as order_count, COALESCE(SUM(total_amount), 0)::numeric as total_sales FROM sales_orders WHERE created_at >= NOW() - INTERVAL '30 days'");

    // Pending payments from invoices
    const pendingPaymentsRes = await db.query("SELECT COALESCE(SUM(amount), 0)::numeric as pending FROM invoices WHERE status = 'pending'");

    // Plan distribution
    const planDistRes = await db.query(`
      SELECT COALESCE(INITCAP(s.plan), 'Starter') as label, COUNT(*)::int as value
      FROM subscriptions s
      GROUP BY COALESCE(INITCAP(s.plan), 'Starter')
      ORDER BY value DESC
    `);

    // Recent 5 restaurants
    const recentRestos = await db.query(`
      SELECT p.id, p.restaurant_name as name, p.owner_name as owner, p.email, p.phone,
             TO_CHAR(p.created_at, 'YYYY-MM-DD') as created,
             p.city, p.business_type as "businessType",
             COALESCE(p.status, 'active') as status,
             COALESCE(s.plan, 'Starter') as plan, COALESCE(s.status, 'active') as "subStatus"
      FROM partners p
      LEFT JOIN subscriptions s ON p.id = s.partner_id
      ORDER BY p.created_at DESC LIMIT 5
    `);

    // Recent payments / orders
    const recentPayments = await db.query(`
      SELECT o.id, o.order_number as invoice, o.total_amount as amount, o.payment_mode as method,
             'Completed' as status, TO_CHAR(o.created_at, 'YYYY-MM-DD') as date, p.restaurant_name as restaurant
      FROM sales_orders o
      LEFT JOIN partners p ON o.restaurant_id = p.id
      ORDER BY o.created_at DESC LIMIT 5
    `);

    // Recent activity logs
    const recentActivityLogs = await db.query(`
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
    `);

    // Dynamic monthly series for charts
    const monthlySeriesRes = await db.query(`
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
    `);

    const newRestaurantsSeries = monthlySeriesRes.rows.map(r => ({ label: r.label, value: Number(r.new_restaurants) }));
    const revenueSeries = monthlySeriesRes.rows.map(r => ({
      label: r.label,
      value: Number(r.sales || 0)
    }));
    const subGrowthSeries = monthlySeriesRes.rows.map(r => ({ label: r.label, value: Number(r.subs) }));

    // Expiring subscriptions
    const expiringRestos = await db.query(`
      SELECT p.id, p.restaurant_name as name, p.owner_name as owner, p.email,
             COALESCE(s.plan, 'Starter') as plan,
             TO_CHAR(s.expiry_date, 'YYYY-MM-DD') as "subExpiry",
             COALESCE(s.status, 'active') as "subStatus"
      FROM partners p
      JOIN subscriptions s ON p.id = s.partner_id
      WHERE s.expiry_date IS NOT NULL
      ORDER BY s.expiry_date ASC LIMIT 5
    `);

    // Open support tickets
    const openTicketsRes = await db.query(`
      SELECT t.id, t.ticket_number as "ticketId", COALESCE(p.restaurant_name, 'Partner') as restaurant,
             t.subject, t.priority, t.status,
             TO_CHAR(t.created_at, 'YYYY-MM-DD') as created
      FROM support_tickets t
      LEFT JOIN partners p ON t.partner_id = p.id
      ORDER BY t.created_at DESC LIMIT 5
    `);

    const mrr = Number(subRevRes.rows[0]?.mrr || 0);
    const monthlyRevenue = Number(ordersRes.rows[0]?.total_sales || 0);
    const pendingPayments = Number(pendingPaymentsRes.rows[0]?.pending || 0);
    const totalRestaurants = parseInt(totalRestoRes.rows[0]?.count || '0', 10);
    const activeRestaurants = parseInt(activeRestoRes.rows[0]?.count || '0', 10);
    const trialRestaurants = parseInt(trialSubRes.rows[0]?.count || '0', 10);
    const expired = parseInt(expiredSubRes.rows[0]?.count || '0', 10);
    const suspended = parseInt(suspendedRes.rows[0]?.count || '0', 10);

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
    const { search = '', status = 'all' } = req.query as any;
    let query = `
      SELECT p.id, p.restaurant_name as name, p.owner_name as owner, p.email, p.phone,
             p.city, COALESCE(p.city, 'India') as address, p.gst_number, p.business_type as "businessType",
             COALESCE(p.status, 'active') as status,
             TO_CHAR(p.created_at, 'YYYY-MM-DD') as created,
             COALESCE(s.plan, 'Starter') as plan,
             COALESCE(s.status, 'active') as "subStatus",
             TO_CHAR(s.expiry_date, 'YYYY-MM-DD') as "subExpiry",
             (SELECT COUNT(*) FROM branches b WHERE b.restaurant_id = p.id)::int as branches,
             (SELECT COUNT(*) FROM restaurant_users u WHERE u.restaurant_id = p.id)::int as users,
             COALESCE((SELECT SUM(total_amount) FROM sales_orders o WHERE o.restaurant_id = p.id), 0)::numeric as total_gmv
      FROM partners p
      LEFT JOIN subscriptions s ON p.id = s.partner_id
      WHERE 1=1
    `;
    const params: any[] = [];
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.restaurant_name ILIKE $${params.length} OR p.owner_name ILIKE $${params.length} OR p.email ILIKE $${params.length} OR p.phone ILIKE $${params.length})`;
    }
    if (status !== 'all') {
      params.push(status);
      query += ` AND LOWER(p.status) = LOWER($${params.length})`;
    }
    query += ` ORDER BY p.created_at DESC`;

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
app.get('/api/admin/subscriptions', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT s.id, s.partner_id as "restaurantId", p.restaurant_name as "restaurantName",
             p.email, COALESCE(s.plan, 'Starter') as plan,
             COALESCE(s.status, 'active') as status,
             TO_CHAR(s.start_date, 'YYYY-MM-DD') as "startDate",
             TO_CHAR(s.expiry_date, 'YYYY-MM-DD') as "expiryDate",
             s.auto_renew as "autoRenew",
             (SELECT COUNT(*) FROM branches b WHERE b.restaurant_id = p.id)::int as "branchesCount",
             (SELECT COUNT(*) FROM restaurant_users u WHERE u.restaurant_id = p.id)::int as "usersCount"
      FROM subscriptions s
      JOIN partners p ON s.partner_id = p.id
      ORDER BY s.created_at DESC
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
app.get('/api/admin/users', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT u.id, u.full_name as name, u.email, u.phone, u.role,
             p.restaurant_name as "restaurantName",
             TO_CHAR(u.created_at, 'YYYY-MM-DD') as created,
             COALESCE(u.status, p.status, 'active') as status
      FROM restaurant_users u
      LEFT JOIN partners p ON u.restaurant_id = p.id
      ORDER BY u.created_at DESC
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
app.get('/api/admin/branches', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT b.id, b.name, b.code, b.city, b.state, b.phone, b.manager_name as manager,
             p.restaurant_name as "restaurantName",
             (SELECT COUNT(*) FROM restaurant_users u WHERE u.branch_id = b.id)::int as users,
             (SELECT COUNT(*) FROM inventory_items i WHERE i.branch_id = b.id)::int as "inventoryItems",
             TO_CHAR(b.created_at, 'YYYY-MM-DD') as created,
             COALESCE(b.status, 'Active') as status
      FROM branches b
      LEFT JOIN partners p ON b.restaurant_id = p.id
      ORDER BY b.created_at DESC
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

