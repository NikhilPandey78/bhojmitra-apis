import { Pool } from 'pg';
import { config } from './config.js';

export const db = new Pool({ connectionString: config.databaseUrl });

export async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, email_verified BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS partners (id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, owner_name TEXT NOT NULL, restaurant_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, restaurant_type TEXT, number_of_branches INTEGER DEFAULT 1, city TEXT, business_name TEXT, gst_number TEXT, business_type TEXT, status TEXT NOT NULL DEFAULT 'trial', onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, plan TEXT NOT NULL DEFAULT 'basic', billing_cycle TEXT NOT NULL DEFAULT 'monthly', status TEXT NOT NULL DEFAULT 'trial', start_date TIMESTAMPTZ DEFAULT NOW(), expiry_date TIMESTAMPTZ, auto_renew BOOLEAN NOT NULL DEFAULT TRUE, amount NUMERIC(10,2) DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS subscription_plans (id SERIAL PRIMARY KEY, name VARCHAR(50) UNIQUE NOT NULL, price NUMERIC(10,2) NOT NULL DEFAULT 0, billing_cycle VARCHAR(20) NOT NULL DEFAULT 'monthly', max_users INTEGER NOT NULL DEFAULT 1, max_branches INTEGER NOT NULL DEFAULT 1, trial_days INTEGER DEFAULT 0, features JSONB DEFAULT '[]', is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, invoice_number TEXT NOT NULL, invoice_date TIMESTAMPTZ DEFAULT NOW(), plan TEXT NOT NULL, amount NUMERIC(10,2) NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS support_tickets (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, ticket_number TEXT NOT NULL, subject TEXT NOT NULL, category TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'new', message TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), closed_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS ticket_replies (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE, sender_type TEXT NOT NULL DEFAULT 'customer', message TEXT NOT NULL, attachment_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, is_read BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, file_name TEXT NOT NULL, file_type TEXT, document_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS demo_requests (id TEXT PRIMARY KEY, name TEXT NOT NULL, restaurant_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, city TEXT, number_of_branches INTEGER DEFAULT 1, preferred_date TEXT, preferred_time TEXT, message TEXT, reference_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS contact_queries (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL, reference_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS sso_authorization_codes (id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_app TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_sso_codes_hash ON sso_authorization_codes(code_hash);
    CREATE INDEX IF NOT EXISTS idx_sso_codes_partner ON sso_authorization_codes(partner_id);
    CREATE INDEX IF NOT EXISTS idx_sso_codes_expires ON sso_authorization_codes(expires_at);

    -- ============================================================
    -- RESTAURANT MANAGEMENT & INVENTORY TABLES
    -- ============================================================
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      phone TEXT,
      manager_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_branches_restaurant ON branches(restaurant_id);

    CREATE TABLE IF NOT EXISTS restaurant_users (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      auth_user_id TEXT,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'staff',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_resto_users_restaurant ON restaurant_users(restaurant_id);

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT DEFAULT '#64748b',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_categories_restaurant ON categories(restaurant_id);

    CREATE TABLE IF NOT EXISTS units (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      base_unit TEXT,
      conversion_factor NUMERIC DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_units_restaurant ON units(restaurant_id);

    CREATE TABLE IF NOT EXISTS unit_conversions (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      from_unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      to_unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      factor NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_unit_conv_restaurant ON unit_conversions(restaurant_id);

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      gst_number TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      payment_terms TEXT DEFAULT 'Net 30',
      outstanding_amount NUMERIC DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_suppliers_restaurant ON suppliers(restaurant_id);

    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      sku TEXT,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      subcategory TEXT,
      unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,
      current_stock NUMERIC NOT NULL DEFAULT 0,
      minimum_stock NUMERIC NOT NULL DEFAULT 0,
      maximum_stock NUMERIC NOT NULL DEFAULT 0,
      purchase_price NUMERIC NOT NULL DEFAULT 0,
      selling_price NUMERIC DEFAULT 0,
      supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
      storage_location TEXT,
      expiry_tracking BOOLEAN NOT NULL DEFAULT FALSE,
      batch_tracking BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_items_restaurant ON inventory_items(restaurant_id);

    CREATE TABLE IF NOT EXISTS stock_transactions (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      transaction_type TEXT NOT NULL,
      quantity_change NUMERIC NOT NULL,
      quantity_after NUMERIC NOT NULL DEFAULT 0,
      reference_type TEXT,
      reference_id TEXT,
      batch_number TEXT,
      expiry_date DATE,
      unit_cost NUMERIC DEFAULT 0,
      reason TEXT,
      notes TEXT,
      performed_by TEXT,
      performed_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_stock_transactions_restaurant ON stock_transactions(restaurant_id);

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      po_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      order_date DATE NOT NULL DEFAULT CURRENT_DATE,
      expected_delivery_date DATE,
      subtotal NUMERIC NOT NULL DEFAULT 0,
      tax_amount NUMERIC NOT NULL DEFAULT 0,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      notes TEXT,
      created_by TEXT,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_po_restaurant ON purchase_orders(restaurant_id);

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id TEXT PRIMARY KEY,
      purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity NUMERIC NOT NULL,
      unit_price NUMERIC NOT NULL,
      tax_percent NUMERIC NOT NULL DEFAULT 0,
      total_price NUMERIC NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(purchase_order_id);

    CREATE TABLE IF NOT EXISTS stock_receipts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
      purchase_order_id TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,
      receipt_number TEXT NOT NULL,
      received_date DATE NOT NULL DEFAULT CURRENT_DATE,
      invoice_number TEXT,
      subtotal NUMERIC NOT NULL DEFAULT 0,
      tax_amount NUMERIC NOT NULL DEFAULT 0,
      discount_amount NUMERIC NOT NULL DEFAULT 0,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      notes TEXT,
      received_by TEXT,
      received_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_stock_receipts_restaurant ON stock_receipts(restaurant_id);

    CREATE TABLE IF NOT EXISTS stock_receipt_items (
      id TEXT PRIMARY KEY,
      stock_receipt_id TEXT NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      item_name TEXT,
      quantity NUMERIC NOT NULL,
      unit TEXT,
      rate NUMERIC NOT NULL,
      tax_percent NUMERIC NOT NULL DEFAULT 0,
      discount_amount NUMERIC NOT NULL DEFAULT 0,
      total NUMERIC NOT NULL,
      batch_number TEXT,
      expiry_date DATE
    );
    CREATE INDEX IF NOT EXISTS idx_stock_receipt_items_receipt ON stock_receipt_items(stock_receipt_id);

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
      stock_receipt_id TEXT REFERENCES stock_receipts(id) ON DELETE SET NULL,
      return_number TEXT NOT NULL,
      return_date DATE NOT NULL DEFAULT CURRENT_DATE,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      total_amount NUMERIC NOT NULL DEFAULT 0,
      notes TEXT,
      created_by TEXT,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_returns_restaurant ON purchase_returns(restaurant_id);

    CREATE TABLE IF NOT EXISTS purchase_return_items (
      id TEXT PRIMARY KEY,
      purchase_return_id TEXT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT REFERENCES inventory_items(id) ON DELETE SET NULL,
      item_name TEXT,
      quantity NUMERIC NOT NULL,
      unit_price NUMERIC NOT NULL DEFAULT 0,
      tax_percent NUMERIC NOT NULL DEFAULT 0,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS stock_issues (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      issue_number TEXT NOT NULL,
      issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
      department TEXT,
      issued_to TEXT,
      notes TEXT,
      total_cost NUMERIC NOT NULL DEFAULT 0,
      created_by TEXT,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_transfers (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      from_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      to_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      transfer_number TEXT NOT NULL,
      transfer_date DATE NOT NULL DEFAULT CURRENT_DATE,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      created_by TEXT,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id TEXT PRIMARY KEY,
      stock_transfer_id TEXT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity NUMERIC NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      adjustment_number TEXT NOT NULL,
      adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
      reason TEXT NOT NULL,
      notes TEXT,
      created_by TEXT,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_adjustment_items (
      id TEXT PRIMARY KEY,
      stock_adjustment_id TEXT NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity_before NUMERIC NOT NULL DEFAULT 0,
      quantity_adjusted NUMERIC NOT NULL,
      quantity_after NUMERIC NOT NULL DEFAULT 0,
      cost_impact NUMERIC NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stock_counts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      count_number TEXT NOT NULL,
      count_date DATE NOT NULL DEFAULT CURRENT_DATE,
      status TEXT NOT NULL DEFAULT 'in_progress',
      notes TEXT,
      created_by TEXT,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_count_items (
      id TEXT PRIMARY KEY,
      stock_count_id TEXT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      system_stock NUMERIC NOT NULL DEFAULT 0,
      counted_stock NUMERIC NOT NULL DEFAULT 0,
      difference NUMERIC NOT NULL DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS kitchen_requisitions (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      requisition_number TEXT NOT NULL,
      requisition_date DATE NOT NULL DEFAULT CURRENT_DATE,
      kitchen_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      created_by TEXT,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kitchen_requisition_items (
      id TEXT PRIMARY KEY,
      kitchen_requisition_id TEXT NOT NULL REFERENCES kitchen_requisitions(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      requested_quantity NUMERIC NOT NULL,
      issued_quantity NUMERIC DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT,
      yield_quantity NUMERIC NOT NULL DEFAULT 1,
      yield_unit TEXT,
      preparation_time INTEGER,
      cooking_time INTEGER,
      cost_per_portion NUMERIC NOT NULL DEFAULT 0,
      selling_price NUMERIC NOT NULL DEFAULT 0,
      instructions TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_recipes_restaurant ON recipes(restaurant_id);

    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity NUMERIC NOT NULL,
      unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,
      cost NUMERIC NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      selling_price NUMERIC NOT NULL,
      cost_price NUMERIC NOT NULL DEFAULT 0,
      food_cost_percentage NUMERIC DEFAULT 0,
      is_vegetarian BOOLEAN DEFAULT TRUE,
      is_available BOOLEAN DEFAULT TRUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id);

    CREATE TABLE IF NOT EXISTS wastage_records (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity NUMERIC NOT NULL,
      reason TEXT NOT NULL,
      cost_impact NUMERIC NOT NULL DEFAULT 0,
      waste_date DATE NOT NULL DEFAULT CURRENT_DATE,
      reported_by TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wastage_restaurant ON wastage_records(restaurant_id);

    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      user_id TEXT,
      user_name TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details JSONB,
      ip_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_activity_logs_restaurant ON activity_logs(restaurant_id);
  `);

  await db.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES subscription_plans(id);
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_action TEXT;
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_plan_id INTEGER REFERENCES subscription_plans(id);
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_plan TEXT;
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_billing_cycle TEXT;
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pending_amount NUMERIC;
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS free_trial_used_at TIMESTAMPTZ;
    UPDATE partners
    SET onboarding_status = CASE WHEN onboarding_completed THEN 'completed' ELSE 'pending' END
    WHERE onboarding_status IS NULL OR onboarding_status NOT IN ('pending', 'in_progress', 'completed');
    DO $$ BEGIN
      ALTER TABLE partners ADD CONSTRAINT partners_onboarding_status_check
      CHECK (onboarding_status IN ('pending', 'in_progress', 'completed'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    ALTER TABLE subscription_plans ALTER COLUMN max_users DROP NOT NULL;
    ALTER TABLE subscription_plans ALTER COLUMN max_branches DROP NOT NULL;
    INSERT INTO subscription_plans (name, price, billing_cycle, max_users, max_branches, trial_days, features)
    VALUES
      ('Free Trial', 0, 'monthly', 2, 2, 14, '["Full feature access", "14-day trial", "2 users per branch", "2 branches"]'),
      ('Starter', 499, 'monthly', 3, 3, 0, '["3 users per branch", "3 branches"]'),
      ('Basic', 999, 'monthly', 5, 5, 0, '["5 users per branch", "5 branches"]'),
      ('Pro', 1999, 'monthly', NULL, NULL, 0, '["Unlimited users per branch", "Unlimited branches"]')
    ON CONFLICT (name) DO UPDATE SET
      price = EXCLUDED.price, billing_cycle = EXCLUDED.billing_cycle,
      max_users = EXCLUDED.max_users, max_branches = EXCLUDED.max_branches,
      trial_days = EXCLUDED.trial_days, features = EXCLUDED.features, is_active = TRUE;
    UPDATE subscriptions s
    SET plan_id = p.id
    FROM subscription_plans p
    WHERE s.plan_id IS NULL AND LOWER(p.name) = LOWER(s.plan);
    UPDATE subscriptions s
    SET plan_id = (SELECT id FROM subscription_plans WHERE name = 'Basic')
    WHERE s.plan_id IS NULL;
  `);
}
