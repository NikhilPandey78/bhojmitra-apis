import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://bhojmitra:Nikhil%401@localhost:5432/bhojmitra',
});

const API_BASE = 'http://127.0.0.1:4000';

interface TestResult {
  step: number;
  category: string;
  name: string;
  expected: string;
  actual: string;
  passed: boolean;
  data?: any;
}

const results: TestResult[] = [];
let stepCounter = 1;

function record(category: string, name: string, expected: string, actual: string, passed: boolean, data?: any) {
  const step = stepCounter++;
  results.push({ step, category, name, expected, actual, passed, data });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`[Test ${step.toString().padStart(3, '0')}] ${icon} [${category}] ${name}`);
  if (!passed) {
    console.log(`   Expected: ${expected}`);
    console.log(`   Actual:   ${actual}`);
  }
}

async function api(
  method: string,
  path: string,
  token: string,
  body?: any
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

async function runIndustryIsolationSuite() {
  console.log('================================================================================');
  console.log('BHOJMITRA 8-INDUSTRY VERTICAL ARCHITECTURE & FEATURE ISOLATION TEST SUITE');
  console.log('================================================================================');

  const client = await pool.connect();

  try {
    const runTag = randomUUID().slice(0, 6);

    // 1. PROVISION 8 TEST TENANTS (1 PER INDUSTRY)
    const industries = [
      { key: 'restaurant', name: 'Spice Route Bistro', owner: 'Ramesh Chef', type: 'restaurant' },
      { key: 'hotel', name: 'Grand Palace Hotel & Resort', owner: 'Alok Manager', type: 'hotel' },
      { key: 'cafe', name: 'Aroma Artisan Cafe', owner: 'Pooja Barista', type: 'cafe' },
      { key: 'grocery', name: 'Fresh Mart Supermarket', owner: 'Gaurav Merchant', type: 'grocery' },
      { key: 'retail', name: 'Trends Fashion Boutique', owner: 'Meera Clothier', type: 'retail' },
      { key: 'sweet_shop', name: 'Royal Mithai Bhandar', owner: 'Kishore Halwai', type: 'sweet_shop' },
      { key: 'bakery', name: 'Golden Crust Bakery', owner: 'Bikram Baker', type: 'bakery' },
      { key: 'hospital', name: 'Metro Care Super Hospital', owner: 'Dr. Anita Roy', type: 'hospital' },
    ];

    const tenantTokens: Record<string, { id: string; token: string; type: string; name: string }> = {};

    for (const ind of industries) {
      const id = randomUUID();
      const email = `${ind.key}_${runTag}@test-industry.bhojmitra.in`;

      await client.query(
        `INSERT INTO users (id, email, password_hash, email_verified, created_at)
         VALUES ($1, $2, 'dummy_hash', true, NOW())`,
        [id, email]
      );

      await client.query(
        `INSERT INTO partners (id, restaurant_name, owner_name, email, phone, business_type, currency, currency_symbol, tax_name, default_tax_rate, locale, status, onboarding_completed, created_at, updated_at)
         VALUES ($1, $2, $3, $4, '+919876543210', $5, 'INR', '₹', 'GST', 5.0, 'en-IN', 'active', true, NOW(), NOW())`,
        [id, ind.name, ind.owner, email, ind.type]
      );

      const token = jwt.sign({ sub: id, email, role: 'owner' }, config.jwtSecret, { expiresIn: '1h' });
      tenantTokens[ind.key] = { id, token, type: ind.type, name: ind.name };

      record(
        'Tenant Provisioning',
        `Provisioned ${ind.type.toUpperCase()} tenant: ${ind.name}`,
        'Tenant active with valid JWT',
        'Provisioned successfully',
        true
      );
    }

    // 2. POSITIVE AUTHORIZED ACCESS VERIFICATIONS
    console.log('\n--- VERIFYING POSITIVE AUTHORIZED ACCESS PER INDUSTRY ---');

    // 2.1 HOTEL Positive Access
    const hotelTok = tenantTokens['hotel'].token;
    const hotelId = tenantTokens['hotel'].id;

    // Hotel Room POST & GET
    const roomPost = await api('POST', '/api/resto/hotel_rooms', hotelTok, {
      room_number: `HR-${runTag}-101`,
      room_type: 'deluxe',
      floor: '1st Floor',
      rate_per_night: 5500,
      status: 'available',
      cleaning_status: 'clean',
    });
    record(
      'Hotel Isolation (Positive)',
      'Hotel tenant creates hotel_rooms',
      'HTTP 200/201 created',
      `HTTP ${roomPost.status}`,
      roomPost.status === 200 || roomPost.status === 201
    );

    const roomGet = await api('GET', '/api/resto/hotel_rooms', hotelTok);
    record(
      'Hotel Isolation (Positive)',
      'Hotel tenant reads hotel_rooms',
      'HTTP 200 with room data',
      `HTTP ${roomGet.status} (count: ${roomGet.body?.data?.length || 0})`,
      roomGet.status === 200 && Array.isArray(roomGet.body?.data) && roomGet.body.data.length > 0
    );

    // Hotel Booking POST & GET
    const bookingPost = await api('POST', '/api/resto/hotel_bookings', hotelTok, {
      booking_number: `HB-${runTag}-001`,
      guest_name: 'John Doe',
      guest_phone: '9876543210',
      room_number: `HR-${runTag}-101`,
      check_in_date: new Date().toISOString().slice(0, 10),
      check_out_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      room_charge: 5500,
      status: 'reserved',
    });
    record(
      'Hotel Isolation (Positive)',
      'Hotel tenant creates hotel_bookings',
      'HTTP 200/201 created',
      `HTTP ${bookingPost.status}`,
      bookingPost.status === 200 || bookingPost.status === 201
    );

    // Hotel Banquet POST & GET
    const banquetPost = await api('POST', '/api/resto/hotel_banquets', hotelTok, {
      booking_number: `BNQ-${runTag}-001`,
      event_name: 'Annual Tech Summit',
      hall_name: 'Grand Ballroom A',
      client_name: 'Tech Corp',
      client_phone: '9876543210',
      event_date: new Date().toISOString().slice(0, 10),
      guest_count: 200,
      package_rate: 750,
      total_amount: 150000,
      advance_paid: 50000,
      balance_due: 100000,
      status: 'confirmed',
    });
    record(
      'Hotel Isolation (Positive)',
      'Hotel tenant creates hotel_banquets',
      'HTTP 200/201 created',
      `HTTP ${banquetPost.status}`,
      banquetPost.status === 200 || banquetPost.status === 201
    );

    // Hotel Pool Ticket POST & GET
    const poolPost = await api('POST', '/api/resto/pool_tickets', hotelTok, {
      ticket_number: `POOL-${runTag}-01`,
      ticket_name: 'Day Pass Adult',
      customer_name: 'Alice Guest',
      customer_phone: '9876543210',
      quantity: 1,
      unit_price: 500,
      total_amount: 500,
      payment_mode: 'cash',
      payment_status: 'paid',
      status: 'active',
      valid_date: new Date().toISOString().slice(0, 10),
    });
    record(
      'Hotel Isolation (Positive)',
      'Hotel tenant creates pool_tickets',
      'HTTP 200/201 created',
      `HTTP ${poolPost.status}`,
      poolPost.status === 200 || poolPost.status === 201
    );

    // 2.2 HOSPITAL Positive Access
    const hospTok = tenantTokens['hospital'].token;

    // Hospital Department POST & GET
    const deptPost = await api('POST', '/api/resto/hospital_departments', hospTok, {
      name: 'Cardiology OPD',
      type: 'medical',
      incharge_name: 'Dr. Mehta',
      status: 'active',
    });
    record(
      'Hospital Isolation (Positive)',
      'Hospital tenant creates hospital_departments',
      'HTTP 200/201 created',
      `HTTP ${deptPost.status}`,
      deptPost.status === 200 || deptPost.status === 201
    );

    const deptGet = await api('GET', '/api/resto/hospital_departments', hospTok);
    record(
      'Hospital Isolation (Positive)',
      'Hospital tenant reads hospital_departments',
      'HTTP 200 with departments',
      `HTTP ${deptGet.status} (count: ${deptGet.body?.data?.length || 0})`,
      deptGet.status === 200 && Array.isArray(deptGet.body?.data) && deptGet.body.data.length > 0
    );

    // Hospital Patient POST & GET
    const patientPost = await api('POST', '/api/resto/hospital_patients', hospTok, {
      patient_code: `PAT-${runTag}-001`,
      full_name: 'Rajesh Kumar',
      age: 45,
      gender: 'Male',
      phone: '9988776655',
      admission_date: new Date().toISOString().slice(0, 10),
      status: 'admitted',
    });
    record(
      'Hospital Isolation (Positive)',
      'Hospital tenant creates hospital_patients',
      'HTTP 200/201 created',
      `HTTP ${patientPost.status}`,
      patientPost.status === 200 || patientPost.status === 201
    );

    // 2.3 SWEET SHOP & BAKERY Positive Access (Production Batches & Custom Orders)
    const sweetTok = tenantTokens['sweet_shop'].token;
    const bakeryTok = tenantTokens['bakery'].token;

    const sweetBatch = await api('POST', '/api/resto/production_batches', sweetTok, {
      batch_number: `BATCH-MITHAI-${runTag}`,
      product_name: 'Kaju Katli Special',
      planned_quantity: 50,
      status: 'completed',
    });
    record(
      'Sweet Shop Isolation (Positive)',
      'Sweet Shop creates production_batches',
      'HTTP 200/201 created',
      `HTTP ${sweetBatch.status}`,
      sweetBatch.status === 200 || sweetBatch.status === 201
    );

    const bakeryBatch = await api('POST', '/api/resto/production_batches', bakeryTok, {
      batch_number: `BATCH-BAKE-${runTag}`,
      product_name: 'Sourdough Artisanal Loaf',
      planned_quantity: 100,
      status: 'in_progress',
    });
    record(
      'Bakery Isolation (Positive)',
      'Bakery creates production_batches',
      'HTTP 200/201 created',
      `HTTP ${bakeryBatch.status}`,
      bakeryBatch.status === 200 || bakeryBatch.status === 201
    );

    // 2.4 F&B (Restaurant, Hotel, Cafe) Positive Access to Dining Tables & KOT
    const restoTok = tenantTokens['restaurant'].token;
    const cafeTok = tenantTokens['cafe'].token;

    const restoTable = await api('POST', '/api/resto/dining_tables', restoTok, {
      table_number: `T-${runTag}-1`,
      name: `Table 1`,
      section: 'Main Dining',
      seating_capacity: 4,
      status: 'available',
    });
    record(
      'Restaurant Isolation (Positive)',
      'Restaurant creates dining_tables',
      'HTTP 200/201 created',
      `HTTP ${restoTable.status}`,
      restoTable.status === 200 || restoTable.status === 201
    );

    const cafeTable = await api('POST', '/api/resto/dining_tables', cafeTok, {
      table_number: `CAFE-${runTag}-1`,
      name: `Cafe Table 1`,
      section: 'Garden',
      seating_capacity: 2,
      status: 'available',
    });
    record(
      'Cafe Isolation (Positive)',
      'Cafe creates dining_tables',
      'HTTP 200/201 created',
      `HTTP ${cafeTable.status}`,
      cafeTable.status === 200 || cafeTable.status === 201
    );

    // 2.5 ALL 8 INDUSTRIES Common Access (Inventory Items, Suppliers, Categories, Sales Orders, Khata)
    console.log('\n--- VERIFYING COMMON MODULE ACCESSIBILITY FOR ALL 8 INDUSTRIES ---');
    for (const [key, t] of Object.entries(tenantTokens)) {
      const itemRes = await api('POST', '/api/resto/inventory_items', t.token, {
        name: `Sample Inventory Item for ${t.name}`,
        cost_price: 100,
        selling_price: 150,
        min_stock: 10,
        current_stock: 50,
      });
      const getRes = await api('GET', '/api/resto/inventory_items', t.token);

      record(
        'Common Modules (Positive)',
        `${t.type.toUpperCase()} accesses common resource (inventory_items)`,
        'HTTP 200 / 201 success',
        `POST: ${itemRes.status}, GET: ${getRes.status}`,
        (itemRes.status === 200 || itemRes.status === 201) && getRes.status === 200
      );
    }

    // 3. NEGATIVE UNAUTHORIZED CROSS-INDUSTRY ACCESS TESTS (HTTP 403 Forbidden)
    console.log('\n--- VERIFYING NEGATIVE CROSS-INDUSTRY UNAUTHORIZED ATTEMPTS (EXPECT 403) ---');

    // 3.1 RESTAURANT -> Hotel, Hospital resources
    const r1 = await api('GET', '/api/resto/hotel_rooms', restoTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Restaurant attempts GET /api/resto/hotel_rooms',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${r1.status} (${r1.body?.code || r1.body?.error})`,
      r1.status === 403 && r1.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const r2 = await api('POST', '/api/resto/hotel_rooms', restoTok, { room_number: '999' });
    record(
      'Cross-Industry Guard (Negative)',
      'Restaurant attempts POST /api/resto/hotel_rooms',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${r2.status} (${r2.body?.code || r2.body?.error})`,
      r2.status === 403 && r2.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const r3 = await api('GET', '/api/resto/hospital_patients', restoTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Restaurant attempts GET /api/resto/hospital_patients',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${r3.status} (${r3.body?.code || r3.body?.error})`,
      r3.status === 403 && r3.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const r4 = await api('GET', '/api/resto/hospital_departments', restoTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Restaurant attempts GET /api/resto/hospital_departments',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${r4.status} (${r4.body?.code || r4.body?.error})`,
      r4.status === 403 && r4.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 3.2 HOSPITAL -> Dining Tables, KOT, Hotel Rooms, Production Batches
    const h1 = await api('GET', '/api/resto/dining_tables', hospTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Hospital attempts GET /api/resto/dining_tables',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${h1.status} (${h1.body?.code || h1.body?.error})`,
      h1.status === 403 && h1.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const h2 = await api('GET', '/api/resto/kot_tickets', hospTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Hospital attempts GET /api/resto/kot_tickets',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${h2.status} (${h2.body?.code || h2.body?.error})`,
      h2.status === 403 && h2.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const h3 = await api('GET', '/api/resto/hotel_rooms', hospTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Hospital attempts GET /api/resto/hotel_rooms',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${h3.status} (${h3.body?.code || h3.body?.error})`,
      h3.status === 403 && h3.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const h4 = await api('GET', '/api/resto/production_batches', hospTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Hospital attempts GET /api/resto/production_batches',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${h4.status} (${h4.body?.code || h4.body?.error})`,
      h4.status === 403 && h4.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 3.3 GROCERY -> Hotel, KOT, Dining Tables, Hospital
    const grocTok = tenantTokens['grocery'].token;
    const g1 = await api('GET', '/api/resto/hotel_rooms', grocTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Grocery attempts GET /api/resto/hotel_rooms',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${g1.status} (${g1.body?.code || g1.body?.error})`,
      g1.status === 403 && g1.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const g2 = await api('GET', '/api/resto/kot_tickets', grocTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Grocery attempts GET /api/resto/kot_tickets',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${g2.status} (${g2.body?.code || g2.body?.error})`,
      g2.status === 403 && g2.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const g3 = await api('GET', '/api/resto/hospital_patients', grocTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Grocery attempts GET /api/resto/hospital_patients',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${g3.status} (${g3.body?.code || g3.body?.error})`,
      g3.status === 403 && g3.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 3.4 RETAIL -> Hotel Banquets, Hospital, KOT
    const retTok = tenantTokens['retail'].token;
    const rt1 = await api('GET', '/api/resto/hotel_banquets', retTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Retail attempts GET /api/resto/hotel_banquets',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${rt1.status} (${rt1.body?.code || rt1.body?.error})`,
      rt1.status === 403 && rt1.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const rt2 = await api('GET', '/api/resto/hospital_departments', retTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Retail attempts GET /api/resto/hospital_departments',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${rt2.status} (${rt2.body?.code || rt2.body?.error})`,
      rt2.status === 403 && rt2.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 3.5 SWEET SHOP -> Hotel Rooms, Hospital Patients
    const s1 = await api('GET', '/api/resto/hotel_rooms', sweetTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Sweet Shop attempts GET /api/resto/hotel_rooms',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${s1.status} (${s1.body?.code || s1.body?.error})`,
      s1.status === 403 && s1.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const s2 = await api('GET', '/api/resto/hospital_patients', sweetTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Sweet Shop attempts GET /api/resto/hospital_patients',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${s2.status} (${s2.body?.code || s2.body?.error})`,
      s2.status === 403 && s2.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 3.6 BAKERY -> Hotel Rooms, Hospital Departments, Dining Tables
    const b1 = await api('GET', '/api/resto/hotel_rooms', bakeryTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Bakery attempts GET /api/resto/hotel_rooms',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${b1.status} (${b1.body?.code || b1.body?.error})`,
      b1.status === 403 && b1.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const b2 = await api('GET', '/api/resto/hospital_departments', bakeryTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Bakery attempts GET /api/resto/hospital_departments',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${b2.status} (${b2.body?.code || b2.body?.error})`,
      b2.status === 403 && b2.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 3.7 HOTEL -> Hospital Patients, Material Requests
    const ht1 = await api('GET', '/api/resto/hospital_patients', hotelTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Hotel attempts GET /api/resto/hospital_patients',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${ht1.status} (${ht1.body?.code || ht1.body?.error})`,
      ht1.status === 403 && ht1.body?.code === 'INDUSTRY_RESTRICTED'
    );

    const ht2 = await api('POST', '/api/resto/material_requests', hotelTok, { request_number: 'REQ-01' });
    record(
      'Cross-Industry Guard (Negative)',
      'Hotel attempts POST /api/resto/material_requests',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${ht2.status} (${ht2.body?.code || ht2.body?.error})`,
      ht2.status === 403 && ht2.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 3.8 CAFE -> Hotel Rooms, Hospital Patients
    const c1 = await api('GET', '/api/resto/hotel_rooms', cafeTok);
    record(
      'Cross-Industry Guard (Negative)',
      'Cafe attempts GET /api/resto/hotel_rooms',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${c1.status} (${c1.body?.code || c1.body?.error})`,
      c1.status === 403 && c1.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 4. SPECIALIZED ENDPOINTS INDUSTRY RESTRICTIONS
    console.log('\n--- VERIFYING SPECIALIZED ENDPOINT ACCESS RESTRICTIONS ---');

    // 4.1 Hotel Checkout Endpoint called by Restaurant -> Expect 403
    const ep1 = await api('POST', '/api/resto/hotel/checkout', restoTok, { booking_id: randomUUID() });
    record(
      'Specialized Route Guard (Negative)',
      'Restaurant attempts POST /api/resto/hotel/checkout',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${ep1.status} (${ep1.body?.code || ep1.body?.error})`,
      ep1.status === 403 && ep1.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 4.2 Night Audit Endpoint called by Hospital -> Expect 403
    const ep2 = await api('POST', '/api/resto/night-audit/run', hospTok, { audit_date: '2026-09-14' });
    record(
      'Specialized Route Guard (Negative)',
      'Hospital attempts POST /api/resto/night-audit/run',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${ep2.status} (${ep2.body?.code || ep2.body?.error})`,
      ep2.status === 403 && ep2.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 4.3 KOT Status Update called by Retail -> Expect 403
    const ep3 = await api('PATCH', `/api/resto/kot/${randomUUID()}/status`, retTok, { status: 'ready' });
    record(
      'Specialized Route Guard (Negative)',
      'Retail attempts PATCH /api/resto/kot/:id/status',
      'HTTP 403 Forbidden (INDUSTRY_RESTRICTED)',
      `HTTP ${ep3.status} (${ep3.body?.code || ep3.body?.error})`,
      ep3.status === 403 && ep3.body?.code === 'INDUSTRY_RESTRICTED'
    );

    // 5. CROSS-TENANT DATA ISOLATION (MULTI-TENANT ENFORCEMENT)
    console.log('\n--- VERIFYING MULTI-TENANT ISOLATION BETWEEN INDEPENDENT ORGANIZATIONS ---');

    // Create a private inventory item in Restaurant
    const restoItem = await api('POST', '/api/resto/inventory_items', restoTok, {
      name: `Private Secret Masala ${runTag}`,
      cost_price: 999,
      selling_price: 1999,
      current_stock: 10,
    });
    const restoItemId = restoItem.body?.data?.[0]?.id || restoItem.body?.data?.id;

    // Cafe attempts to query Restaurant's item by ID
    const cafeQueryResto = await api('GET', `/api/resto/inventory_items?id=${restoItemId}`, cafeTok);
    const leakedItem = (cafeQueryResto.body?.data || []).find((i: any) => i.id === restoItemId);
    record(
      'Multi-Tenant Isolation',
      'Cafe queries Restaurant inventory item by exact ID',
      'Empty result / Item not leaked',
      leakedItem ? 'LEAKED' : 'Isolated (0 items found)',
      !leakedItem
    );

    // Cafe attempts to PATCH Restaurant's item
    const cafePatchResto = await api('PATCH', `/api/resto/inventory_items?id=${restoItemId}`, cafeTok, {
      name: 'Hacked Masala',
    });
    const dbCheck = (await client.query('SELECT name FROM inventory_items WHERE id = $1', [restoItemId])).rows[0];
    record(
      'Multi-Tenant Isolation',
      'Cafe attempts PATCH on Restaurant item',
      'Item name unchanged in DB',
      `DB Name: "${dbCheck?.name}"`,
      dbCheck?.name !== 'Hacked Masala'
    );

    // Cafe attempts to DELETE Restaurant's item
    await api('DELETE', `/api/resto/inventory_items?id=${restoItemId}`, cafeTok);
    const dbCheck2 = (await client.query('SELECT id FROM inventory_items WHERE id = $1', [restoItemId])).rows[0];
    record(
      'Multi-Tenant Isolation',
      'Cafe attempts DELETE on Restaurant item',
      'Item still exists in DB',
      dbCheck2 ? 'Record preserved' : 'Record deleted (LEAK)',
      Boolean(dbCheck2)
    );

    // SUMMARY
    console.log('\n================================================================================');
    console.log('INDUSTRY ISOLATION SUITE EXECUTION SUMMARY');
    console.log('================================================================================');

    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const passPct = ((passed / total) * 100).toFixed(2);
    const failPct = ((failed / total) * 100).toFixed(2);

    console.log(`Total Executed Tests : ${total}`);
    console.log(`Passed               : ${passed}`);
    console.log(`Failed               : ${failed}`);
    console.log(`Pass Percentage      : ${passPct}%`);
    console.log(`Fail Percentage      : ${failPct}%`);
    console.log('================================================================================\n');

  } catch (err) {
    console.error('Test Suite Fatal Error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

runIndustryIsolationSuite();
