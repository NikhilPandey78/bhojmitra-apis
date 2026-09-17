import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { db } from './db.js';

async function seedBhojmitraDemoUser() {
  const client = await db.connect();
  try {
    console.log('Provisioning BhojMitra Demo Master User: bhojmitra@gmail.com ...');
    await client.query('BEGIN');

    const email = 'bhojmitra@gmail.com';
    const password = 'bhojmitra@123';
    const passwordHash = await bcrypt.hash(password, 12);

    // 1. Check if user already exists
    const existingUser = (await client.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
    let userId = existingUser?.id || randomUUID();

    if (existingUser) {
      await client.query('UPDATE users SET password_hash = $1, email_verified = true WHERE id = $2', [passwordHash, userId]);
      console.log(`Updated existing user password for ${email}`);
    } else {
      await client.query(
        'INSERT INTO users (id, email, password_hash, email_verified, created_at) VALUES ($1, $2, $3, true, NOW())',
        [userId, email, passwordHash]
      );
      console.log(`Created new user record for ${email}`);
    }

    // 2. Provision or update Partner (Restaurant / Hotel)
    const existingPartner = (await client.query('SELECT id FROM partners WHERE id = $1', [userId])).rows[0];
    if (existingPartner) {
      await client.query(`
        UPDATE partners
        SET owner_name = 'BhojMitra Admin',
            restaurant_name = 'BhojMitra Grand Palace & Resort',
            business_name = 'BhojMitra Hospitality Group',
            phone = '+91 9876543210',
            business_type = 'hotel',
            restaurant_type = 'hotel',
            status = 'active',
            onboarding_completed = true,
            currency = 'INR',
            currency_symbol = '₹',
            tax_name = 'GST',
            default_tax_rate = 5.0,
            number_of_branches = 5,
            city = 'New Delhi',
            updated_at = NOW()
        WHERE id = $1
      `, [userId]);
    } else {
      await client.query(`
        INSERT INTO partners (
          id, owner_name, restaurant_name, business_name, email, phone,
          business_type, restaurant_type, status, onboarding_completed,
          currency, currency_symbol, tax_name, default_tax_rate, number_of_branches, city, created_at, updated_at
        ) VALUES (
          $1, 'BhojMitra Admin', 'BhojMitra Grand Palace & Resort', 'BhojMitra Hospitality Group',
          $2, '+91 9876543210', 'hotel', 'hotel', 'active', true,
          'INR', '₹', 'GST', 5.0, 5, 'New Delhi', NOW(), NOW()
        )
      `, [userId, email]);
    }

    // 3. Provision or update restaurant_users
    const existingRestoUser = (await client.query('SELECT id FROM restaurant_users WHERE auth_user_id = $1 OR (restaurant_id = $1 AND email = $2)', [userId, email])).rows[0];
    const allPermissions = JSON.stringify([
      'all', 'view', 'create', 'edit', 'delete', 'approve', 'transfer', 'sell',
      'close_register', 'reports', 'settings', 'pos', 'hotel', 'inventory',
      'kitchen', 'housekeeping', 'engineering', 'banquet', 'pool', 'manage_users'
    ]);

    if (existingRestoUser) {
      await client.query(`
        UPDATE restaurant_users
        SET role = 'owner',
            full_name = 'BhojMitra Admin',
            permissions = $1,
            status = 'active',
            updated_at = NOW()
        WHERE id = $2
      `, [allPermissions, existingRestoUser.id]);
    } else {
      await client.query(`
        INSERT INTO restaurant_users (
          id, restaurant_id, auth_user_id, full_name, email, phone, role, status, permissions, created_at, updated_at
        ) VALUES (
          $1, $2, $2, 'BhojMitra Admin', $3, '+91 9876543210', 'owner', 'active', $4, NOW(), NOW()
        )
      `, [randomUUID(), userId, email, allPermissions]);
    }

    // 4. Ensure Active Enterprise Subscription
    const enterprisePlan = (await client.query("SELECT id FROM subscription_plans WHERE name = 'Enterprise' OR name = 'Custom' LIMIT 1")).rows[0];
    const planId = enterprisePlan?.id || null;

    const existingSub = (await client.query('SELECT id FROM subscriptions WHERE partner_id = $1', [userId])).rows[0];
    if (existingSub) {
      await client.query(`
        UPDATE subscriptions
        SET plan = 'enterprise',
            status = 'active',
            expiry_date = NOW() + INTERVAL '10 years',
            auto_renew = true,
            plan_id = $1
        WHERE id = $2
      `, [planId, existingSub.id]);
    } else {
      await client.query(`
        INSERT INTO subscriptions (
          id, partner_id, plan, billing_cycle, status, start_date, expiry_date, auto_renew, amount, plan_id, created_at
        ) VALUES (
          $1, $2, 'enterprise', 'yearly', 'active', NOW(), NOW() + INTERVAL '10 years', true, 99999.00, $3, NOW()
        )
      `, [randomUUID(), userId, planId]);
    }

    // 5. Seed Inventory Locations
    const locMap: Record<string, string> = {};
    const locationsToCreate = [
      { name: 'Central Warehouse (Main Stores)', type: 'warehouse' },
      { name: 'Kitchen 1 (Main Dining)', type: 'kitchen' },
      { name: 'Kitchen 2 (Banquet & Pool)', type: 'kitchen' },
      { name: 'Restaurant Service Floor', type: 'outlet' },
      { name: 'Bar & Lounge Outlet', type: 'outlet' },
      { name: 'Garden Café', type: 'outlet' },
      { name: 'Sky Lounge', type: 'outlet' },
      { name: 'Housekeeping Store', type: 'department' },
      { name: 'Engineering Workshop', type: 'department' },
    ];

    for (const loc of locationsToCreate) {
      const existing = (await client.query('SELECT id FROM inventory_locations WHERE restaurant_id = $1 AND name = $2', [userId, loc.name])).rows[0];
      if (existing) {
        locMap[loc.name] = existing.id;
      } else {
        const id = 'loc_' + randomUUID().slice(0, 8);
        await client.query(
          'INSERT INTO inventory_locations (id, restaurant_id, name, type, is_active, created_at) VALUES ($1, $2, $3, $4, true, NOW())',
          [id, userId, loc.name, loc.type]
        );
        locMap[loc.name] = id;
      }
    }

    // 6. Seed Categories & Units
    const unitKgId = 'unit_kg_' + randomUUID().slice(0, 8);
    const unitLtrId = 'unit_ltr_' + randomUUID().slice(0, 8);
    const unitBottleId = 'unit_btl_' + randomUUID().slice(0, 8);
    const unitPieceId = 'unit_pc_' + randomUUID().slice(0, 8);

    await client.query(`
      INSERT INTO units (id, restaurant_id, name, symbol)
      VALUES 
        ($1, $5, 'Kilogram', 'kg'),
        ($2, $5, 'Liter', 'L'),
        ($3, $5, 'Bottle (750ml)', 'btl'),
        ($4, $5, 'Piece', 'pc')
      ON CONFLICT DO NOTHING
    `, [unitKgId, unitLtrId, unitBottleId, unitPieceId, userId]);

    // 7. Seed Inventory Items
    const items = [
      { name: 'Basmati Rice Premium', category: 'food', unit: 'kg', cost: 95.00 },
      { name: 'Fresh Farm Chicken', category: 'food', unit: 'kg', cost: 220.00 },
      { name: 'Cooking Sunflower Oil', category: 'food', unit: 'L', cost: 140.00 },
      { name: 'Dark Rum 750ml (Bottle)', category: 'liquor', unit: 'btl', cost: 1200.00 },
      { name: 'Premium Mineral Water 1L', category: 'retail', unit: 'btl', cost: 25.00 },
      { name: 'Industrial Floor Disinfectant', category: 'housekeeping', unit: 'L', cost: 180.00 },
      { name: 'VRV HVAC Air Filter', category: 'engineering', unit: 'pc', cost: 450.00 },
    ];

    const itemMap: Record<string, string> = {};
    for (const item of items) {
      const existing = (await client.query('SELECT id FROM inventory_items WHERE restaurant_id = $1 AND name = $2', [userId, item.name])).rows[0];
      if (existing) {
        itemMap[item.name] = existing.id;
      } else {
        const id = 'inv_' + randomUUID().slice(0, 8);
        await client.query(`
          INSERT INTO inventory_items (id, restaurant_id, name, purchase_price, selling_price, current_stock, minimum_stock, status, created_at)
          VALUES ($1, $2, $3, $4, $4 * 1.5, 100, 10, 'active', NOW())
        `, [id, userId, item.name, item.cost]);
        itemMap[item.name] = id;
      }
    }

    // Seed Location Inventory
    const cwId = locMap['Central Warehouse (Main Stores)'];
    const k1Id = locMap['Kitchen 1 (Main Dining)'];
    const barId = locMap['Bar & Lounge Outlet'];
    const hkId = locMap['Housekeeping Store'];
    const engId = locMap['Engineering Workshop'];

    for (const [itemName, itemId] of Object.entries(itemMap)) {
      if (cwId) {
        await client.query(`
          INSERT INTO location_inventory (id, restaurant_id, location_id, item_id, quantity, updated_at)
          VALUES ($1, $2, $3, $4, 100, NOW())
          ON CONFLICT (location_id, item_id) DO UPDATE SET quantity = 100
        `, [randomUUID(), userId, cwId, itemId]);
      }
    }

    if (k1Id && itemMap['Fresh Farm Chicken']) {
      await client.query(`
        INSERT INTO location_inventory (id, restaurant_id, location_id, item_id, quantity, updated_at)
        VALUES ($1, $2, $3, $4, 40, NOW())
        ON CONFLICT (location_id, item_id) DO UPDATE SET quantity = 40
      `, [randomUUID(), userId, k1Id, itemMap['Fresh Farm Chicken']]);
    }
    if (barId && itemMap['Dark Rum 750ml (Bottle)']) {
      await client.query(`
        INSERT INTO location_inventory (id, restaurant_id, location_id, item_id, quantity, updated_at)
        VALUES ($1, $2, $3, $4, 15, NOW())
        ON CONFLICT (location_id, item_id) DO UPDATE SET quantity = 15
      `, [randomUUID(), userId, barId, itemMap['Dark Rum 750ml (Bottle)']]);
    }
    if (hkId && itemMap['Industrial Floor Disinfectant']) {
      await client.query(`
        INSERT INTO location_inventory (id, restaurant_id, location_id, item_id, quantity, updated_at)
        VALUES ($1, $2, $3, $4, 20, NOW())
        ON CONFLICT (location_id, item_id) DO UPDATE SET quantity = 20
      `, [randomUUID(), userId, hkId, itemMap['Industrial Floor Disinfectant']]);
    }
    if (engId && itemMap['VRV HVAC Air Filter']) {
      await client.query(`
        INSERT INTO location_inventory (id, restaurant_id, location_id, item_id, quantity, updated_at)
        VALUES ($1, $2, $3, $4, 10, NOW())
        ON CONFLICT (location_id, item_id) DO UPDATE SET quantity = 10
      `, [randomUUID(), userId, engId, itemMap['VRV HVAC Air Filter']]);
    }

    // 8. Seed Hotel Rooms
    const rooms = [
      { num: '101', type: 'Deluxe Room', rate: 4500, floor: '1st Floor', status: 'occupied', clean: 'clean' },
      { num: '102', type: 'Deluxe Room', rate: 4500, floor: '1st Floor', status: 'available', clean: 'clean' },
      { num: '103', type: 'Deluxe Room', rate: 4500, floor: '1st Floor', status: 'cleaning', clean: 'dirty' },
      { num: '201', type: 'Executive Suite', rate: 7500, floor: '2nd Floor', status: 'occupied', clean: 'clean' },
      { num: '202', type: 'Executive Suite', rate: 7500, floor: '2nd Floor', status: 'available', clean: 'clean' },
      { num: '301', type: 'Presidential Penthouse', rate: 15000, floor: '3rd Floor', status: 'available', clean: 'clean' },
    ];

    const roomMap: Record<string, string> = {};
    for (const r of rooms) {
      const existing = (await client.query('SELECT id FROM hotel_rooms WHERE restaurant_id = $1 AND room_number = $2', [userId, r.num])).rows[0];
      if (existing) {
        roomMap[r.num] = existing.id;
        await client.query(`
          UPDATE hotel_rooms
          SET room_type = $1, rate_per_night = $2, floor = $3, status = $4, cleaning_status = $5
          WHERE id = $6
        `, [r.type, r.rate, r.floor, r.status, r.clean, existing.id]);
      } else {
        const id = 'room_' + r.num + '_' + randomUUID().slice(0, 4);
        await client.query(`
          INSERT INTO hotel_rooms (id, restaurant_id, room_number, room_type, rate_per_night, floor, status, cleaning_status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        `, [id, userId, r.num, r.type, r.rate, r.floor, r.status, r.clean]);
        roomMap[r.num] = id;
      }
    }

    // 9. Seed Active Bookings for Room 101 & 201
    if (roomMap['101']) {
      const existingBooking = (await client.query("SELECT id FROM hotel_bookings WHERE restaurant_id = $1 AND room_number = '101' AND status = 'checked_in'", [userId])).rows[0];
      if (!existingBooking) {
        await client.query(`
          INSERT INTO hotel_bookings (
            id, restaurant_id, room_id, booking_number, guest_name, guest_phone, guest_email,
            room_number, room_type, check_in_date, check_out_date, adults, room_charge, total_amount, paid_amount, balance_due, payment_mode, status, created_at
          ) VALUES (
            $1, $2, $3, 'BK-2026-101', 'Vikramaditya Sharma', '+91 9988776655', 'vikram@example.com',
            '101', 'Deluxe Room', CURRENT_DATE, CURRENT_DATE + INTERVAL '2 days', 2, 9000, 9000, 4500, 4500, 'card', 'checked_in', NOW()
          )
        `, ['book_101_' + randomUUID().slice(0, 6), userId, roomMap['101']]);
      }
    }

    // 10. Seed Pool Pass Ticket Types
    const poolTypes = [
      { name: 'Adult Day Pass', price: 500, desc: 'Full-day access to Olympic Pool & Lounger' },
      { name: 'Child Day Pass (Under 12)', price: 250, desc: 'Pool entry & safety tube kit' },
      { name: 'VIP Cabana Day Pass', price: 2000, desc: 'Private cabana with fruit platter & 2 towels' },
    ];

    for (const pt of poolTypes) {
      const existing = (await client.query('SELECT id FROM pool_ticket_types WHERE restaurant_id = $1 AND name = $2', [userId, pt.name])).rows[0];
      if (!existing) {
        await client.query(`
          INSERT INTO pool_ticket_types (id, restaurant_id, name, price, description, is_active, created_at)
          VALUES ($1, $2, $3, $4, $5, true, NOW())
        `, ['pt_' + randomUUID().slice(0, 8), userId, pt.name, pt.price, pt.desc]);
      }
    }

    // 11. Seed Dining Tables
    const tables = [
      { num: 'T-01', cap: 4, sec: 'Main Hall' },
      { num: 'T-02', cap: 2, sec: 'Main Hall' },
      { num: 'T-03', cap: 6, sec: 'Family Section' },
      { num: 'R-01', cap: 4, sec: 'Rooftop Terrace' },
      { num: 'R-02', cap: 8, sec: 'Rooftop VIP Lounge' },
      { num: 'POOL-1', cap: 4, sec: 'Poolside Deck' },
    ];

    for (const t of tables) {
      const existing = (await client.query('SELECT id FROM dining_tables WHERE restaurant_id = $1 AND table_number = $2', [userId, t.num])).rows[0];
      if (!existing) {
        await client.query(`
          INSERT INTO dining_tables (id, restaurant_id, table_number, seating_capacity, section, status, created_at)
          VALUES ($1, $2, $3, $4, $5, 'available', NOW())
        `, ['tbl_' + randomUUID().slice(0, 8), userId, t.num, t.cap, t.sec]);
      }
    }

    // 12. Seed Housekeeping Tasks
    if (roomMap['103']) {
      const existingHk = (await client.query("SELECT id FROM housekeeping_tasks WHERE restaurant_id = $1 AND room_number = '103' AND status = 'pending'", [userId])).rows[0];
      if (!existingHk) {
        await client.query(`
          INSERT INTO housekeeping_tasks (id, restaurant_id, room_id, room_number, task_type, priority, status, notes, created_at)
          VALUES ($1, $2, $3, '103', 'checkout_turnover', 'urgent', 'pending', 'Turnover requested after guest departure', NOW())
        `, ['hk_' + randomUUID().slice(0, 8), userId, roomMap['103']]);
      }
    }

    // 13. Seed Engineering Maintenance Tickets
    if (roomMap['103']) {
      const existingEng = (await client.query("SELECT id FROM engineering_tickets WHERE restaurant_id = $1 AND room_number = '103' AND status = 'open'", [userId])).rows[0];
      if (!existingEng) {
        await client.query(`
          INSERT INTO engineering_tickets (id, restaurant_id, ticket_number, title, description, asset_name, room_id, room_number, priority, status, total_cost, created_at)
          VALUES ($1, $2, 'ENG-2026-001', 'AC Thermostat Inspection', 'Inspect split AC temperature sensor', 'Daikin VRV AC', $3, '103', 'medium', 'open', 0, NOW())
        `, ['eng_' + randomUUID().slice(0, 8), userId, roomMap['103']]);
      }
    }

    // 14. Seed Banquet Events
    const existingBanquet = (await client.query("SELECT id FROM hotel_banquets WHERE restaurant_id = $1 AND hall_name = 'Grand Ballroom Imperial'", [userId])).rows[0];
    if (!existingBanquet) {
      await client.query(`
        INSERT INTO hotel_banquets (
          id, restaurant_id, booking_number, hall_name, event_name, client_name, client_phone, client_email,
          event_date, start_time, end_time, guest_count, package_rate, catering_amount, decoration_amount,
          total_amount, advance_paid, balance_due, status, created_at, updated_at
        ) VALUES (
          $1, $2, 'BNQ-2026-001', 'Grand Ballroom Imperial', 'Annual Corporate Tech Gala', 'Innovate Global Ltd', '+91 9876501234', 'events@innovate.com',
          CURRENT_DATE + INTERVAL '5 days', '18:00', '23:00', 250, 150000, 75000, 25000, 250000, 100000, 150000, 'confirmed', NOW(), NOW()
        )
      `, ['bnq_' + randomUUID().slice(0, 8), userId]);
    }

    await client.query('COMMIT');
    console.log('>>> BHOJMITRA DEMO USER SUCCESSFULLY PROVISIONED AND SEEDED! <<<');
    console.log(`Email:    ${email}`);
    console.log(`Password: ${password}`);
    console.log(`User ID:  ${userId}`);
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error provisioning demo user:', err);
    process.exit(1);
  } finally {
    client.release();
    await db.end();
  }
}

seedBhojmitraDemoUser();
