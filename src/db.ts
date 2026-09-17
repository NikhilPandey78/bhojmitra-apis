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
    CREATE TABLE IF NOT EXISTS website_visitors (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      device_type TEXT DEFAULT 'desktop',
      browser TEXT DEFAULT 'Chrome',
      os TEXT DEFAULT 'Windows',
      city TEXT DEFAULT 'India',
      country TEXT DEFAULT 'India',
      referrer TEXT,
      landing_page TEXT DEFAULT '/',
      current_page TEXT DEFAULT '/',
      time_spent_seconds INTEGER DEFAULT 0,
      is_online BOOLEAN DEFAULT TRUE,
      last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_visitors_session ON website_visitors(session_id);
    CREATE INDEX IF NOT EXISTS idx_visitors_online ON website_visitors(is_online);
    CREATE INDEX IF NOT EXISTS idx_visitors_heartbeat ON website_visitors(last_heartbeat);
    CREATE INDEX IF NOT EXISTS idx_visitors_created ON website_visitors(created_at);

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
      permissions JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE restaurant_users ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '[]';
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
      factor NUMERIC DEFAULT 1,
      multiplier NUMERIC DEFAULT 1,
      conversion_factor NUMERIC DEFAULT 1,
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
      issue_type TEXT,
      issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
      department TEXT,
      issued_to TEXT,
      reason TEXT,
      notes TEXT,
      total_cost NUMERIC NOT NULL DEFAULT 0,
      total_value NUMERIC NOT NULL DEFAULT 0,
      issued_by TEXT,
      issued_by_name TEXT,
      created_by TEXT,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_stock_issues_restaurant ON stock_issues(restaurant_id);

    CREATE TABLE IF NOT EXISTS stock_issue_items (
      id TEXT PRIMARY KEY,
      stock_issue_id TEXT NOT NULL REFERENCES stock_issues(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT REFERENCES inventory_items(id) ON DELETE CASCADE,
      item_name TEXT,
      quantity NUMERIC NOT NULL DEFAULT 0,
      unit TEXT,
      rate NUMERIC NOT NULL DEFAULT 0,
      total NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_stock_issue_items_issue ON stock_issue_items(stock_issue_id);
    CREATE INDEX IF NOT EXISTS idx_stock_issue_items_restaurant ON stock_issue_items(restaurant_id);

    ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS issue_type TEXT;
    ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS reason TEXT;
    ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS total_value NUMERIC DEFAULT 0;
    ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS issued_by TEXT;
    ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS issued_by_name TEXT;

    CREATE TABLE IF NOT EXISTS stock_transfers (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      from_branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      to_branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      transfer_number TEXT,
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

    -- Inventory & Management column migrations
    ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS item_name TEXT;
    ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS received_quantity NUMERIC DEFAULT 0;
    ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS unit TEXT;
    ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS rate NUMERIC DEFAULT 0;
    ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC DEFAULT 0;
    ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS total NUMERIC DEFAULT 0;

    ALTER TABLE purchase_return_items ADD COLUMN IF NOT EXISTS item_name TEXT;
    ALTER TABLE purchase_return_items ADD COLUMN IF NOT EXISTS unit TEXT;
    ALTER TABLE purchase_return_items ADD COLUMN IF NOT EXISTS rate NUMERIC DEFAULT 0;
    ALTER TABLE purchase_return_items ADD COLUMN IF NOT EXISTS total NUMERIC DEFAULT 0;
    ALTER TABLE purchase_return_items ADD COLUMN IF NOT EXISTS reason TEXT;

    ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS total_value NUMERIC DEFAULT 0;
    ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS adjusted_by TEXT;
    ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS adjusted_by_name TEXT;

    ALTER TABLE stock_adjustment_items ADD COLUMN IF NOT EXISTS item_name TEXT;
    ALTER TABLE stock_adjustment_items ADD COLUMN IF NOT EXISTS system_quantity NUMERIC DEFAULT 0;
    ALTER TABLE stock_adjustment_items ADD COLUMN IF NOT EXISTS physical_quantity NUMERIC DEFAULT 0;
    ALTER TABLE stock_adjustment_items ADD COLUMN IF NOT EXISTS variance NUMERIC DEFAULT 0;
    ALTER TABLE stock_adjustment_items ADD COLUMN IF NOT EXISTS unit TEXT;
    ALTER TABLE stock_adjustment_items ADD COLUMN IF NOT EXISTS rate NUMERIC DEFAULT 0;
    ALTER TABLE stock_adjustment_items ADD COLUMN IF NOT EXISTS total NUMERIC DEFAULT 0;
    ALTER TABLE stock_adjustment_items ADD COLUMN IF NOT EXISTS reason TEXT;

    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS reason TEXT;
    ALTER TABLE stock_transfer_items ADD COLUMN IF NOT EXISTS item_name TEXT;
    ALTER TABLE stock_transfer_items ADD COLUMN IF NOT EXISTS unit TEXT;

    ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS total_variance NUMERIC DEFAULT 0;
    ALTER TABLE stock_count_items ADD COLUMN IF NOT EXISTS item_name TEXT;
    ALTER TABLE stock_count_items ADD COLUMN IF NOT EXISTS unit TEXT;
    ALTER TABLE stock_count_items ADD COLUMN IF NOT EXISTS expected_quantity NUMERIC DEFAULT 0;
    ALTER TABLE stock_count_items ADD COLUMN IF NOT EXISTS actual_quantity NUMERIC;
    ALTER TABLE stock_count_items ADD COLUMN IF NOT EXISTS variance NUMERIC;

    ALTER TABLE kitchen_requisitions ADD COLUMN IF NOT EXISTS department TEXT;
    ALTER TABLE kitchen_requisitions ADD COLUMN IF NOT EXISTS required_date DATE;
    ALTER TABLE kitchen_requisitions ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal';
    ALTER TABLE kitchen_requisitions ADD COLUMN IF NOT EXISTS requested_by TEXT;
    ALTER TABLE kitchen_requisitions ADD COLUMN IF NOT EXISTS requested_by_name TEXT;
    ALTER TABLE kitchen_requisitions ADD COLUMN IF NOT EXISTS approved_by TEXT;
    ALTER TABLE kitchen_requisitions ADD COLUMN IF NOT EXISTS approved_by_name TEXT;

    ALTER TABLE kitchen_requisition_items ADD COLUMN IF NOT EXISTS item_name TEXT;
    ALTER TABLE kitchen_requisition_items ADD COLUMN IF NOT EXISTS unit TEXT;
    ALTER TABLE kitchen_requisition_items ADD COLUMN IF NOT EXISTS quantity NUMERIC DEFAULT 0;

    ALTER TABLE recipes ADD COLUMN IF NOT EXISTS preparation_cost NUMERIC DEFAULT 0;
    ALTER TABLE recipes ADD COLUMN IF NOT EXISTS total_cost NUMERIC DEFAULT 0;
    ALTER TABLE recipes ADD COLUMN IF NOT EXISTS servings INTEGER DEFAULT 1;
    ALTER TABLE recipes ADD COLUMN IF NOT EXISTS notes TEXT;

    ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS item_name TEXT;
    ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS unit TEXT;
    ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS unit_cost NUMERIC DEFAULT 0;
    ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS total_cost NUMERIC DEFAULT 0;

    ALTER TABLE wastage_records ADD COLUMN IF NOT EXISTS wastage_number TEXT;
    ALTER TABLE wastage_records ADD COLUMN IF NOT EXISTS item_name TEXT;
    ALTER TABLE wastage_records ADD COLUMN IF NOT EXISTS unit TEXT;
    ALTER TABLE wastage_records ADD COLUMN IF NOT EXISTS rate NUMERIC DEFAULT 0;
    ALTER TABLE wastage_records ADD COLUMN IF NOT EXISTS total_cost NUMERIC DEFAULT 0;
    ALTER TABLE wastage_records ADD COLUMN IF NOT EXISTS location TEXT;
    ALTER TABLE wastage_records ADD COLUMN IF NOT EXISTS recorded_by TEXT;
    ALTER TABLE wastage_records ADD COLUMN IF NOT EXISTS recorded_by_name TEXT;

    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS food_cost NUMERIC DEFAULT 0;
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS food_cost_percent NUMERIC DEFAULT 0;
    ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS gross_margin NUMERIC DEFAULT 0;

    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS module TEXT;
    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE activity_logs ALTER COLUMN entity_type DROP NOT NULL;
    ALTER TABLE activity_logs ALTER COLUMN action DROP NOT NULL;

    ALTER TABLE unit_conversions ADD COLUMN IF NOT EXISTS multiplier NUMERIC DEFAULT 1;
    ALTER TABLE unit_conversions ADD COLUMN IF NOT EXISTS conversion_factor NUMERIC DEFAULT 1;
    ALTER TABLE unit_conversions ALTER COLUMN factor DROP NOT NULL;
    ALTER TABLE unit_conversions ALTER COLUMN factor SET DEFAULT 1;

    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS restaurant_id TEXT REFERENCES partners(id) ON DELETE CASCADE;
    UPDATE notifications SET restaurant_id = partner_id WHERE restaurant_id IS NULL;
    ALTER TABLE notifications ALTER COLUMN partner_id DROP NOT NULL;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS idx_notifications_restaurant ON notifications(restaurant_id);

    ALTER TABLE purchase_orders ALTER COLUMN supplier_id DROP NOT NULL;
    ALTER TABLE purchase_order_items ALTER COLUMN unit_price DROP NOT NULL;
    ALTER TABLE purchase_order_items ALTER COLUMN total_price DROP NOT NULL;
    ALTER TABLE purchase_order_items ALTER COLUMN unit_price SET DEFAULT 0;
    ALTER TABLE purchase_order_items ALTER COLUMN total_price SET DEFAULT 0;

    ALTER TABLE stock_adjustment_items ALTER COLUMN quantity_adjusted DROP NOT NULL;
    ALTER TABLE stock_adjustment_items ALTER COLUMN quantity_adjusted SET DEFAULT 0;

    ALTER TABLE kitchen_requisition_items ALTER COLUMN requested_quantity DROP NOT NULL;
    ALTER TABLE kitchen_requisition_items ALTER COLUMN requested_quantity SET DEFAULT 0;

    ALTER TABLE stock_receipt_items ALTER COLUMN rate DROP NOT NULL;
    ALTER TABLE stock_receipt_items ALTER COLUMN total DROP NOT NULL;
    ALTER TABLE stock_receipt_items ALTER COLUMN rate SET DEFAULT 0;
    ALTER TABLE stock_receipt_items ALTER COLUMN total SET DEFAULT 0;
    INSERT INTO subscription_plans (name, price, billing_cycle, max_users, max_branches, trial_days, features)
    VALUES
      ('Free Trial', 0, 'monthly', 2, 1, 14, '["Full feature access", "14-day trial", "Up to 2 team members", "1 branch"]'),
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

    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS partner_id TEXT REFERENCES partners(id) ON DELETE CASCADE;
    UPDATE suppliers SET partner_id = restaurant_id WHERE partner_id IS NULL AND restaurant_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_suppliers_partner_id ON suppliers(partner_id);
    CREATE INDEX IF NOT EXISTS idx_suppliers_restaurant ON suppliers(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_suppliers_partner_name ON suppliers(restaurant_id, name);

    -- ============================================================
    -- TABLES, KOT, POS ORDERS & CUSTOMERS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS dining_tables (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      table_number TEXT NOT NULL,
      name TEXT NOT NULL,
      section TEXT NOT NULL DEFAULT 'Main Dining',
      seating_capacity INTEGER NOT NULL DEFAULT 4,
      status TEXT NOT NULL DEFAULT 'available',
      current_order_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dining_tables_restaurant ON dining_tables(restaurant_id);

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      total_orders INTEGER NOT NULL DEFAULT 0,
      total_spend NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_customers_restaurant ON customers(restaurant_id);

    CREATE TABLE IF NOT EXISTS sales_orders (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      table_id TEXT REFERENCES dining_tables(id) ON DELETE SET NULL,
      order_number TEXT NOT NULL,
      order_type TEXT NOT NULL DEFAULT 'dine_in',
      customer_name TEXT,
      customer_phone TEXT,
      customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
      subtotal NUMERIC NOT NULL DEFAULT 0,
      discount_amount NUMERIC NOT NULL DEFAULT 0,
      discount_percent NUMERIC NOT NULL DEFAULT 0,
      tax_amount NUMERIC NOT NULL DEFAULT 0,
      tax_percent NUMERIC NOT NULL DEFAULT 5,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'paid',
      payment_mode TEXT NOT NULL DEFAULT 'cash',
      status TEXT NOT NULL DEFAULT 'completed',
      notes TEXT,
      created_by TEXT,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sales_orders_restaurant ON sales_orders(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_sales_orders_created ON sales_orders(created_at DESC);

    CREATE TABLE IF NOT EXISTS sales_order_items (
      id TEXT PRIMARY KEY,
      sales_order_id TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT REFERENCES inventory_items(id) ON DELETE SET NULL,
      menu_item_id TEXT REFERENCES menu_items(id) ON DELETE SET NULL,
      item_name TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 1,
      unit_price NUMERIC NOT NULL DEFAULT 0,
      tax_percent NUMERIC NOT NULL DEFAULT 0,
      total_price NUMERIC NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sales_items_order ON sales_order_items(sales_order_id);
    CREATE INDEX IF NOT EXISTS idx_sales_items_restaurant ON sales_order_items(restaurant_id);

    CREATE TABLE IF NOT EXISTS kot_tickets (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      table_id TEXT REFERENCES dining_tables(id) ON DELETE SET NULL,
      table_number TEXT,
      sales_order_id TEXT REFERENCES sales_orders(id) ON DELETE SET NULL,
      kot_number TEXT NOT NULL,
      order_type TEXT NOT NULL DEFAULT 'dine_in',
      server_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kot_restaurant ON kot_tickets(restaurant_id);

    CREATE TABLE IF NOT EXISTS kot_items (
      id TEXT PRIMARY KEY,
      kot_id TEXT NOT NULL REFERENCES kot_tickets(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 1,
      unit TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_kot_items_kot ON kot_items(kot_id);

    -- ============================================================
    -- COMPREHENSIVE MULTI-VERTICAL & PRODUCT MASTER MIGRATIONS
    -- ============================================================
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS barcode TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS item_code TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS brand TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS hsn_sac TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS gst_rate NUMERIC DEFAULT 0;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS tax_rate NUMERIC DEFAULT 0;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS reorder_level NUMERIC DEFAULT 0;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS opening_stock NUMERIC DEFAULT 0;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS min_stock NUMERIC DEFAULT 0;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS max_stock NUMERIC DEFAULT 0;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_url TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sub_category TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS unit TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category TEXT;
    CREATE INDEX IF NOT EXISTS idx_inventory_items_barcode ON inventory_items(restaurant_id, barcode);

    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS gstin TEXT;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_name TEXT;

    ALTER TABLE dining_tables ALTER COLUMN name DROP NOT NULL;
    ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS table_name TEXT;

    ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS type TEXT;
    ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS quantity NUMERIC;
    ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS unit_price NUMERIC DEFAULT 0;
    ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS total_price NUMERIC DEFAULT 0;
    ALTER TABLE stock_transactions ALTER COLUMN transaction_type DROP NOT NULL;
    ALTER TABLE stock_transactions ALTER COLUMN quantity_change DROP NOT NULL;

    ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid';
    ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS payment_mode TEXT;
    ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_number TEXT;

    ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS hsn_sac TEXT;
    ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS gst_rate NUMERIC DEFAULT 0;

    ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS payment_reference TEXT;
    ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS table_name TEXT;

    ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS hsn_sac TEXT;
    ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS barcode TEXT;

    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS table_name TEXT;
    ALTER TABLE kot_items ADD COLUMN IF NOT EXISTS item_id TEXT;

    -- ============================================================
    -- HOTEL & HOSPITALITY MODULE TABLES
    -- ============================================================
    CREATE TABLE IF NOT EXISTS hotel_rooms (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      room_number TEXT NOT NULL,
      room_type TEXT NOT NULL DEFAULT 'Deluxe',
      floor TEXT NOT NULL DEFAULT '1st Floor',
      rate_per_night NUMERIC NOT NULL DEFAULT 0,
      seating_capacity INTEGER DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'available',
      amenities JSONB DEFAULT '[]',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hotel_rooms_restaurant ON hotel_rooms(restaurant_id);

    CREATE TABLE IF NOT EXISTS hotel_bookings (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      room_id TEXT REFERENCES hotel_rooms(id) ON DELETE SET NULL,
      booking_number TEXT NOT NULL,
      guest_name TEXT NOT NULL,
      guest_phone TEXT NOT NULL,
      guest_email TEXT,
      id_proof_type TEXT,
      id_proof_number TEXT,
      room_number TEXT,
      room_type TEXT,
      check_in_date DATE NOT NULL,
      check_out_date DATE NOT NULL,
      actual_check_in TIMESTAMPTZ,
      actual_check_out TIMESTAMPTZ,
      adults INTEGER DEFAULT 1,
      children INTEGER DEFAULT 0,
      room_charge NUMERIC NOT NULL DEFAULT 0,
      room_service_charge NUMERIC DEFAULT 0,
      extra_charge NUMERIC DEFAULT 0,
      tax_amount NUMERIC DEFAULT 0,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      paid_amount NUMERIC NOT NULL DEFAULT 0,
      balance_due NUMERIC NOT NULL DEFAULT 0,
      payment_mode TEXT DEFAULT 'cash',
      status TEXT NOT NULL DEFAULT 'reserved',
      special_requests TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hotel_bookings_restaurant ON hotel_bookings(restaurant_id);

    CREATE TABLE IF NOT EXISTS hotel_banquets (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      booking_number TEXT NOT NULL,
      hall_name TEXT NOT NULL,
      event_name TEXT NOT NULL,
      client_name TEXT NOT NULL,
      client_phone TEXT NOT NULL,
      client_email TEXT,
      event_date DATE NOT NULL,
      start_time TEXT,
      end_time TEXT,
      guest_count INTEGER NOT NULL DEFAULT 50,
      package_rate NUMERIC NOT NULL DEFAULT 0,
      catering_amount NUMERIC DEFAULT 0,
      decoration_amount NUMERIC DEFAULT 0,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      advance_paid NUMERIC NOT NULL DEFAULT 0,
      balance_due NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'confirmed',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hotel_banquets_restaurant ON hotel_banquets(restaurant_id);

    -- ============================================================
    -- HOSPITAL & CLINICAL MODULE TABLES
    -- ============================================================
    CREATE TABLE IF NOT EXISTS hospital_departments (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'Ward',
      incharge_name TEXT,
      contact_phone TEXT,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hospital_depts_restaurant ON hospital_departments(restaurant_id);

    CREATE TABLE IF NOT EXISTS hospital_patients (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      patient_code TEXT NOT NULL,
      full_name TEXT NOT NULL,
      age INTEGER,
      gender TEXT,
      phone TEXT,
      ward_name TEXT,
      bed_number TEXT,
      doctor_name TEXT,
      diagnosis TEXT,
      admission_date DATE NOT NULL DEFAULT CURRENT_DATE,
      discharge_date DATE,
      status TEXT NOT NULL DEFAULT 'admitted',
      total_medicine_charges NUMERIC DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hospital_patients_restaurant ON hospital_patients(restaurant_id);

    CREATE TABLE IF NOT EXISTS patient_medicine_issues (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      patient_id TEXT REFERENCES hospital_patients(id) ON DELETE CASCADE,
      issue_number TEXT NOT NULL,
      patient_name TEXT NOT NULL,
      ward_name TEXT,
      bed_number TEXT,
      doctor_name TEXT,
      issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'dispensed',
      items JSONB DEFAULT '[]',
      dispensed_by TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_patient_med_issues_restaurant ON patient_medicine_issues(restaurant_id);

    CREATE TABLE IF NOT EXISTS material_requests (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      request_number TEXT NOT NULL,
      department_id TEXT REFERENCES hospital_departments(id) ON DELETE SET NULL,
      department_name TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      doctor_name TEXT,
      urgency TEXT NOT NULL DEFAULT 'routine',
      status TEXT NOT NULL DEFAULT 'pending',
      items JSONB DEFAULT '[]',
      approved_by TEXT,
      approval_notes TEXT,
      required_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_material_requests_restaurant ON material_requests(restaurant_id);

    -- ============================================================
    -- SWEET SHOP & BAKERY PRODUCTION MODULE TABLES
    -- ============================================================
    CREATE TABLE IF NOT EXISTS production_batches (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      batch_number TEXT NOT NULL,
      recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      planned_quantity NUMERIC NOT NULL DEFAULT 0,
      actual_yield_quantity NUMERIC NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'kg',
      batch_cost NUMERIC NOT NULL DEFAULT 0,
      cost_per_unit NUMERIC NOT NULL DEFAULT 0,
      scrap_wastage NUMERIC DEFAULT 0,
      production_date DATE NOT NULL DEFAULT CURRENT_DATE,
      expiry_date DATE,
      status TEXT NOT NULL DEFAULT 'completed',
      raw_materials_consumed JSONB DEFAULT '[]',
      notes TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_production_batches_restaurant ON production_batches(restaurant_id);

    CREATE TABLE IF NOT EXISTS custom_orders (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      order_number TEXT NOT NULL,
      order_type TEXT NOT NULL DEFAULT 'custom_cake',
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_email TEXT,
      item_name TEXT NOT NULL,
      flavor_theme TEXT,
      weight_kg NUMERIC DEFAULT 1,
      delivery_date DATE NOT NULL,
      delivery_time TEXT,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      advance_paid NUMERIC NOT NULL DEFAULT 0,
      balance_due NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'confirmed',
      special_instructions TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_custom_orders_restaurant ON custom_orders(restaurant_id);

    -- ============================================================
    -- RETAIL & GROCERY KHATA, DAY CLOSING & POS QUEUE TABLES
    -- ============================================================
    CREATE TABLE IF NOT EXISTS customer_khata (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
      customer_name TEXT NOT NULL,
      phone TEXT,
      credit_limit NUMERIC DEFAULT 10000,
      total_credit NUMERIC NOT NULL DEFAULT 0,
      total_paid NUMERIC NOT NULL DEFAULT 0,
      balance_due NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      transactions JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_customer_khata_restaurant ON customer_khata(restaurant_id);

    CREATE TABLE IF NOT EXISTS pos_held_bills (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      bill_reference TEXT NOT NULL,
      customer_name TEXT,
      customer_phone TEXT,
      items JSONB NOT NULL DEFAULT '[]',
      subtotal NUMERIC NOT NULL DEFAULT 0,
      tax_amount NUMERIC NOT NULL DEFAULT 0,
      discount_amount NUMERIC NOT NULL DEFAULT 0,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      order_type TEXT DEFAULT 'dine_in',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pos_held_bills_restaurant ON pos_held_bills(restaurant_id);

    CREATE TABLE IF NOT EXISTS day_closings (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      closing_number TEXT NOT NULL,
      closing_date DATE NOT NULL DEFAULT CURRENT_DATE,
      opening_cash NUMERIC NOT NULL DEFAULT 0,
      cash_sales NUMERIC NOT NULL DEFAULT 0,
      upi_sales NUMERIC NOT NULL DEFAULT 0,
      card_sales NUMERIC NOT NULL DEFAULT 0,
      credit_sales NUMERIC NOT NULL DEFAULT 0,
      cash_expenses NUMERIC NOT NULL DEFAULT 0,
      expected_cash NUMERIC NOT NULL DEFAULT 0,
      actual_cash NUMERIC NOT NULL DEFAULT 0,
      discrepancy NUMERIC NOT NULL DEFAULT 0,
      total_revenue NUMERIC NOT NULL DEFAULT 0,
      total_orders INTEGER NOT NULL DEFAULT 0,
      closed_by TEXT,
      status TEXT NOT NULL DEFAULT 'closed',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_day_closings_restaurant ON day_closings(restaurant_id);

    CREATE TABLE IF NOT EXISTS purchase_payments (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      po_id TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,
      voucher_number TEXT NOT NULL,
      payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
      amount NUMERIC NOT NULL DEFAULT 0,
      payment_mode TEXT NOT NULL DEFAULT 'bank_transfer',
      reference_no TEXT,
      notes TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_payments_restaurant ON purchase_payments(restaurant_id);

    -- Extended Product Master & Procurement Columns
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS size TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS color TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS model TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS serial_number TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS mrp NUMERIC DEFAULT 0;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC DEFAULT 0;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS weight_unit TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_weight_based BOOLEAN DEFAULT FALSE;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS price_per_kg NUMERIC DEFAULT 0;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS pack_size TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS drug_schedule TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS rack_location TEXT;
    ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_perishable BOOLEAN DEFAULT FALSE;

    ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'approved';
    ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_by TEXT;
    ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS paid_amount NUMERIC DEFAULT 0;
    ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS outstanding_balance NUMERIC DEFAULT 0;
    ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_date DATE;

    -- ============================================================
    -- MULTI-LOCATION INVENTORY & CENTRAL WAREHOUSE TABLES
    -- ============================================================
    CREATE TABLE IF NOT EXISTS inventory_locations (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      code TEXT,
      type TEXT NOT NULL DEFAULT 'outlet', -- warehouse, kitchen, outlet, department
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      is_default BOOLEAN DEFAULT FALSE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_inv_locations_restaurant ON inventory_locations(restaurant_id);

    CREATE TABLE IF NOT EXISTS location_inventory (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity NUMERIC NOT NULL DEFAULT 0,
      min_stock NUMERIC DEFAULT 0,
      reorder_level NUMERIC DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (location_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_loc_inv_restaurant ON location_inventory(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_loc_inv_location ON location_inventory(location_id);
    CREATE INDEX IF NOT EXISTS idx_loc_inv_item ON location_inventory(item_id);

    -- ============================================================
    -- POS OUTLETS & STATIONS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS pos_outlets (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      location_id TEXT REFERENCES inventory_locations(id) ON DELETE SET NULL,
      kitchen_location_id TEXT REFERENCES inventory_locations(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL, -- restaurant, bar, cafe, sky_lounge, pool, banquet, room_service
      outlet_type TEXT NOT NULL DEFAULT 'dine_in',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      receipt_header TEXT,
      receipt_footer TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pos_outlets_restaurant ON pos_outlets(restaurant_id);

    -- ============================================================
    -- HOTEL FOLIO TRANSACTIONS (CHARGE TO ROOM)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS hotel_folio_transactions (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      booking_id TEXT NOT NULL REFERENCES hotel_bookings(id) ON DELETE CASCADE,
      room_id TEXT REFERENCES hotel_rooms(id) ON DELETE SET NULL,
      outlet_id TEXT REFERENCES pos_outlets(id) ON DELETE SET NULL,
      outlet_name TEXT,
      order_id TEXT REFERENCES sales_orders(id) ON DELETE SET NULL,
      order_number TEXT,
      charge_type TEXT NOT NULL DEFAULT 'restaurant',
      description TEXT NOT NULL,
      amount NUMERIC NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hotel_folio_restaurant ON hotel_folio_transactions(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_hotel_folio_booking ON hotel_folio_transactions(booking_id);

    -- ============================================================
    -- POOL TICKETING MODULE
    -- ============================================================
    CREATE TABLE IF NOT EXISTS pool_ticket_types (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price NUMERIC NOT NULL DEFAULT 0,
      description TEXT,
      duration_hours NUMERIC DEFAULT 4,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pool_ticket_types_restaurant ON pool_ticket_types(restaurant_id);

    CREATE TABLE IF NOT EXISTS pool_tickets (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      ticket_type_id TEXT REFERENCES pool_ticket_types(id) ON DELETE SET NULL,
      ticket_number TEXT NOT NULL,
      ticket_name TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      room_number TEXT,
      guest_booking_id TEXT REFERENCES hotel_bookings(id) ON DELETE SET NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price NUMERIC NOT NULL DEFAULT 0,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      payment_mode TEXT NOT NULL DEFAULT 'cash',
      payment_status TEXT NOT NULL DEFAULT 'paid',
      status TEXT NOT NULL DEFAULT 'active',
      valid_date DATE NOT NULL DEFAULT CURRENT_DATE,
      sold_by TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pool_tickets_restaurant ON pool_tickets(restaurant_id);

    -- ============================================================
    -- HOUSEKEEPING TASKS & LINEN
    -- ============================================================
    CREATE TABLE IF NOT EXISTS housekeeping_tasks (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      room_id TEXT REFERENCES hotel_rooms(id) ON DELETE CASCADE,
      room_number TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'daily_cleaning',
      assigned_to TEXT,
      assigned_to_name TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'pending',
      checklist JSONB DEFAULT '[]',
      linen_issued JSONB DEFAULT '[]',
      amenities_issued JSONB DEFAULT '[]',
      notes TEXT,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hk_tasks_restaurant ON housekeeping_tasks(restaurant_id);

    -- ============================================================
    -- ENGINEERING / MAINTENANCE WORK ORDERS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS engineering_tickets (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      ticket_number TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      asset_name TEXT,
      room_id TEXT REFERENCES hotel_rooms(id) ON DELETE SET NULL,
      room_number TEXT,
      location_id TEXT REFERENCES inventory_locations(id) ON DELETE SET NULL,
      location_name TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_to TEXT,
      assigned_to_name TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      parts_consumed JSONB DEFAULT '[]',
      total_cost NUMERIC NOT NULL DEFAULT 0,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_eng_tickets_restaurant ON engineering_tickets(restaurant_id);

    -- ============================================================
    -- HOTEL NIGHT AUDIT
    -- ============================================================
    CREATE TABLE IF NOT EXISTS hotel_night_audits (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      audit_number TEXT NOT NULL,
      audit_date DATE NOT NULL DEFAULT CURRENT_DATE,
      room_revenue NUMERIC NOT NULL DEFAULT 0,
      pos_revenue NUMERIC NOT NULL DEFAULT 0,
      banquet_revenue NUMERIC NOT NULL DEFAULT 0,
      pool_revenue NUMERIC NOT NULL DEFAULT 0,
      other_revenue NUMERIC NOT NULL DEFAULT 0,
      total_revenue NUMERIC NOT NULL DEFAULT 0,
      total_rooms INTEGER NOT NULL DEFAULT 0,
      occupied_rooms INTEGER NOT NULL DEFAULT 0,
      occupancy_rate NUMERIC NOT NULL DEFAULT 0,
      room_charges_posted NUMERIC NOT NULL DEFAULT 0,
      payments_collected NUMERIC NOT NULL DEFAULT 0,
      audited_by TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_night_audits_restaurant ON hotel_night_audits(restaurant_id);

    -- ============================================================
    -- EXTENDED ATTRIBUTES & SETTINGS FOR INTERNATIONALIZATION
    -- ============================================================
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR';
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS currency_symbol TEXT DEFAULT '₹';
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS tax_name TEXT DEFAULT 'GST';
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS default_tax_rate NUMERIC DEFAULT 5;
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS locale TEXT DEFAULT 'en-US';
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS auto_deduct_recipe_stock BOOLEAN DEFAULT TRUE;

    ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS outlet_id TEXT;
    ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS outlet_name TEXT;
    ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS location_id TEXT;
    ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS is_room_charge BOOLEAN DEFAULT FALSE;
    ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS room_id TEXT;
    ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS guest_booking_id TEXT;
    ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS folio_transaction_id TEXT;

    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS from_location_id TEXT;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS to_location_id TEXT;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS approved_by TEXT;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS completed_by TEXT;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
    ALTER TABLE stock_transfers ALTER COLUMN from_branch_id DROP NOT NULL;
    ALTER TABLE stock_transfers ALTER COLUMN to_branch_id DROP NOT NULL;
    ALTER TABLE stock_transfers ALTER COLUMN transfer_number DROP NOT NULL;

    ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS location_id TEXT;
    ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS location_id TEXT;
    ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS location_id TEXT;
    ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS location_id TEXT;
    ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS location_id TEXT;

    ALTER TABLE day_closings ADD COLUMN IF NOT EXISTS outlet_id TEXT;
    ALTER TABLE day_closings ADD COLUMN IF NOT EXISTS outlet_name TEXT;
    ALTER TABLE day_closings ADD COLUMN IF NOT EXISTS location_id TEXT;
    ALTER TABLE day_closings ADD COLUMN IF NOT EXISTS shift_number TEXT;

    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS folio_charges JSONB DEFAULT '[]';
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS bar_charge NUMERIC DEFAULT 0;
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS pool_charge NUMERIC DEFAULT 0;
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS banquet_charge NUMERIC DEFAULT 0;

    ALTER TABLE hotel_rooms ADD COLUMN IF NOT EXISTS cleaning_status TEXT DEFAULT 'clean';

    -- ============================================================
    -- PERFORMANCE OPTIMIZATION INDEXES (PHASE 4 AUDIT)
    -- ============================================================
    -- 1. Partners & Tenants
    CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status);
    CREATE INDEX IF NOT EXISTS idx_partners_business_type ON partners(business_type);
    CREATE INDEX IF NOT EXISTS idx_partners_created ON partners(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_partners_email ON partners(email);

    -- 2. Subscriptions
    CREATE INDEX IF NOT EXISTS idx_subscriptions_partner ON subscriptions(partner_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_plan ON subscriptions(plan);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry ON subscriptions(expiry_date);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_created ON subscriptions(created_at DESC);

    -- 3. Invoices & Payments
    CREATE INDEX IF NOT EXISTS idx_invoices_partner ON invoices(partner_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at DESC);

    -- 4. Support Tickets
    CREATE INDEX IF NOT EXISTS idx_support_tickets_partner ON support_tickets(partner_id);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets(created_at DESC);

    -- 5. Branches & Users
    CREATE INDEX IF NOT EXISTS idx_branches_rest_status ON branches(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_resto_users_branch ON restaurant_users(branch_id);
    CREATE INDEX IF NOT EXISTS idx_resto_users_rest_status ON restaurant_users(restaurant_id, status);

    -- 6. Recipes & Recipe Ingredients
    CREATE INDEX IF NOT EXISTS idx_recipes_rest_status ON recipes(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_recipe_ing_recipe ON recipe_ingredients(recipe_id);
    CREATE INDEX IF NOT EXISTS idx_recipe_ing_rest ON recipe_ingredients(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_recipe_ing_item ON recipe_ingredients(item_id);

    -- 7. Menu Items
    CREATE INDEX IF NOT EXISTS idx_menu_items_recipe ON menu_items(recipe_id);
    CREATE INDEX IF NOT EXISTS idx_menu_items_rest_avail ON menu_items(restaurant_id, is_available);

    -- 8. Inventory, Location Inventory & Transactions
    CREATE INDEX IF NOT EXISTS idx_inv_items_rest_status ON inventory_items(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_inv_items_category ON inventory_items(category_id);
    CREATE INDEX IF NOT EXISTS idx_inv_items_supplier ON inventory_items(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_stock_tx_rest_date ON stock_transactions(restaurant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_tx_item ON stock_transactions(item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_tx_type ON stock_transactions(transaction_type);
    CREATE INDEX IF NOT EXISTS idx_stock_tx_location ON stock_transactions(location_id);

    -- 9. Sales Orders & Items
    CREATE INDEX IF NOT EXISTS idx_sales_orders_rest_outlet ON sales_orders(restaurant_id, outlet_id);
    CREATE INDEX IF NOT EXISTS idx_sales_orders_rest_created ON sales_orders(restaurant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sales_orders_status ON sales_orders(status);
    CREATE INDEX IF NOT EXISTS idx_sales_orders_booking ON sales_orders(guest_booking_id);
    CREATE INDEX IF NOT EXISTS idx_sales_items_menu_item ON sales_order_items(menu_item_id);

    -- 10. Transfers, Issues, Receipts, Counts, Adjustments
    CREATE INDEX IF NOT EXISTS idx_stock_transfers_rest ON stock_transfers(restaurant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_transfers_from_loc ON stock_transfers(from_location_id);
    CREATE INDEX IF NOT EXISTS idx_stock_transfers_to_loc ON stock_transfers(to_location_id);
    CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_transfer ON stock_transfer_items(stock_transfer_id);
    CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_rest ON stock_transfer_items(restaurant_id);

    CREATE INDEX IF NOT EXISTS idx_stock_adjustments_rest ON stock_adjustments(restaurant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_adj_items_adj ON stock_adjustment_items(stock_adjustment_id);
    CREATE INDEX IF NOT EXISTS idx_stock_adj_items_rest ON stock_adjustment_items(restaurant_id);

    CREATE INDEX IF NOT EXISTS idx_stock_counts_rest ON stock_counts(restaurant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_count_items_count ON stock_count_items(stock_count_id);
    CREATE INDEX IF NOT EXISTS idx_stock_count_items_rest ON stock_count_items(restaurant_id);

    CREATE INDEX IF NOT EXISTS idx_stock_receipts_rest ON stock_receipts(restaurant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_receipt_items_rcpt ON stock_receipt_items(stock_receipt_id);
    CREATE INDEX IF NOT EXISTS idx_stock_receipt_items_rest ON stock_receipt_items(restaurant_id);

    CREATE INDEX IF NOT EXISTS idx_purchase_returns_rest ON purchase_returns(restaurant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_purchase_return_items_ret ON purchase_return_items(purchase_return_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_return_items_rest ON purchase_return_items(restaurant_id);

    CREATE INDEX IF NOT EXISTS idx_kitchen_reqs_rest ON kitchen_requisitions(restaurant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_kitchen_req_items_req ON kitchen_requisition_items(kitchen_requisition_id);
    CREATE INDEX IF NOT EXISTS idx_kitchen_req_items_rest ON kitchen_requisition_items(restaurant_id);

    -- 11. Hotel Operations
    CREATE INDEX IF NOT EXISTS idx_hotel_rooms_rest_status ON hotel_rooms(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_hotel_bookings_rest_status ON hotel_bookings(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_hotel_bookings_room ON hotel_bookings(room_id);
    CREATE INDEX IF NOT EXISTS idx_hotel_bookings_dates ON hotel_bookings(check_in_date, check_out_date);
    CREATE INDEX IF NOT EXISTS idx_hotel_banquets_rest_date ON hotel_banquets(restaurant_id, event_date);
    CREATE INDEX IF NOT EXISTS idx_hk_tasks_rest_status ON housekeeping_tasks(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_hk_tasks_room ON housekeeping_tasks(room_id);
    CREATE INDEX IF NOT EXISTS idx_eng_tickets_rest_status ON engineering_tickets(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS idx_day_closings_rest_outlet ON day_closings(restaurant_id, outlet_id);
    CREATE INDEX IF NOT EXISTS idx_day_closings_date ON day_closings(closing_date DESC);
    CREATE INDEX IF NOT EXISTS idx_night_audits_rest_date ON hotel_night_audits(restaurant_id, audit_date DESC);

    -- ============================================================
    -- PHASE 2-24 ENTERPRISE HOTEL PMS, FOLIO, KDS & LIQUOR SCHEMAS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS hotel_guests (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      nationality TEXT DEFAULT 'Indian',
      id_proof_type TEXT DEFAULT 'Aadhaar Card',
      id_proof_number TEXT,
      address TEXT,
      city TEXT,
      country TEXT DEFAULT 'India',
      company_name TEXT,
      gst_number TEXT,
      vip_tier TEXT DEFAULT 'standard',
      preferences TEXT,
      total_stays INTEGER DEFAULT 0,
      total_spend NUMERIC DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hotel_guests_rest_phone ON hotel_guests(restaurant_id, phone);

    CREATE TABLE IF NOT EXISTS hotel_rate_plans (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      room_type TEXT,
      meal_plan TEXT DEFAULT 'European Plan (Room Only)',
      base_rate NUMERIC NOT NULL DEFAULT 0,
      extra_adult_rate NUMERIC DEFAULT 0,
      extra_child_rate NUMERIC DEFAULT 0,
      cancellation_policy TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rate_plans_rest ON hotel_rate_plans(restaurant_id);

    CREATE TABLE IF NOT EXISTS hotel_folios (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      booking_id TEXT NOT NULL REFERENCES hotel_bookings(id) ON DELETE CASCADE,
      folio_number TEXT NOT NULL,
      guest_id TEXT REFERENCES hotel_guests(id) ON DELETE SET NULL,
      room_id TEXT REFERENCES hotel_rooms(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open',
      total_charges NUMERIC NOT NULL DEFAULT 0,
      total_tax NUMERIC NOT NULL DEFAULT 0,
      total_discount NUMERIC NOT NULL DEFAULT 0,
      total_payments NUMERIC NOT NULL DEFAULT 0,
      balance_due NUMERIC NOT NULL DEFAULT 0,
      credit_limit NUMERIC DEFAULT 50000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_folios_rest_booking ON hotel_folios(restaurant_id, booking_id);

    CREATE TABLE IF NOT EXISTS hotel_folio_items (
      id TEXT PRIMARY KEY,
      folio_id TEXT NOT NULL REFERENCES hotel_folios(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      booking_id TEXT NOT NULL REFERENCES hotel_bookings(id) ON DELETE CASCADE,
      window_number INTEGER NOT NULL DEFAULT 1,
      charge_category TEXT NOT NULL,
      source_module TEXT NOT NULL DEFAULT 'front_desk',
      outlet_id TEXT,
      outlet_name TEXT,
      reference_type TEXT,
      reference_id TEXT,
      description TEXT NOT NULL,
      amount NUMERIC NOT NULL DEFAULT 0,
      tax_amount NUMERIC NOT NULL DEFAULT 0,
      discount_amount NUMERIC NOT NULL DEFAULT 0,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      posted_by TEXT,
      posted_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_folio_items_folio ON hotel_folio_items(folio_id);
    CREATE INDEX IF NOT EXISTS idx_folio_items_rest ON hotel_folio_items(restaurant_id);
    CREATE INDEX IF NOT EXISTS idx_folio_items_booking ON hotel_folio_items(booking_id);

    CREATE TABLE IF NOT EXISTS hotel_room_moves (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      booking_id TEXT NOT NULL REFERENCES hotel_bookings(id) ON DELETE CASCADE,
      from_room_id TEXT NOT NULL REFERENCES hotel_rooms(id) ON DELETE CASCADE,
      to_room_id TEXT NOT NULL REFERENCES hotel_rooms(id) ON DELETE CASCADE,
      from_room_number TEXT NOT NULL,
      to_room_number TEXT NOT NULL,
      reason TEXT NOT NULL,
      rate_difference NUMERIC DEFAULT 0,
      moved_by TEXT,
      moved_by_name TEXT,
      moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_room_moves_booking ON hotel_room_moves(booking_id);

    CREATE TABLE IF NOT EXISTS kds_stations (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      outlet_id TEXT REFERENCES pos_outlets(id) ON DELETE SET NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      printer_ip TEXT,
      auto_bump_seconds INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kds_stations_rest ON kds_stations(restaurant_id);

    CREATE TABLE IF NOT EXISTS kds_priority_logs (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      ticket_id TEXT NOT NULL REFERENCES kot_tickets(id) ON DELETE CASCADE,
      kot_number TEXT NOT NULL,
      old_priority TEXT NOT NULL,
      new_priority TEXT NOT NULL,
      reason TEXT NOT NULL,
      changed_by TEXT,
      changed_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kds_prio_rest ON kds_priority_logs(restaurant_id);

    CREATE TABLE IF NOT EXISTS bar_bottle_sessions (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      brand_name TEXT NOT NULL,
      bottle_size_ml NUMERIC NOT NULL DEFAULT 750,
      peg_size_ml NUMERIC NOT NULL DEFAULT 30,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_pegs_sold NUMERIC NOT NULL DEFAULT 0,
      ml_consumed NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE INDEX IF NOT EXISTS idx_bar_sessions_rest ON bar_bottle_sessions(restaurant_id);

    CREATE TABLE IF NOT EXISTS bar_daily_closings (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      closing_date DATE NOT NULL DEFAULT CURRENT_DATE,
      outlet_id TEXT REFERENCES pos_outlets(id) ON DELETE SET NULL,
      item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      opening_ml NUMERIC NOT NULL DEFAULT 0,
      received_ml NUMERIC NOT NULL DEFAULT 0,
      sold_ml NUMERIC NOT NULL DEFAULT 0,
      wastage_ml NUMERIC NOT NULL DEFAULT 0,
      theoretical_closing_ml NUMERIC NOT NULL DEFAULT 0,
      physical_closing_ml NUMERIC NOT NULL DEFAULT 0,
      variance_ml NUMERIC NOT NULL DEFAULT 0,
      cost_variance NUMERIC NOT NULL DEFAULT 0,
      closed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bar_closings_rest ON bar_daily_closings(restaurant_id, closing_date);

    CREATE TABLE IF NOT EXISTS hotel_business_dates (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL UNIQUE REFERENCES partners(id) ON DELETE CASCADE,
      current_business_date DATE NOT NULL DEFAULT CURRENT_DATE,
      last_audit_date DATE,
      is_audit_in_progress BOOLEAN NOT NULL DEFAULT FALSE,
      locked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_biz_dates_rest ON hotel_business_dates(restaurant_id);
    ALTER TABLE hotel_business_dates ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    -- Extended Hotel Columns Migrations
    ALTER TABLE hotel_rooms ADD COLUMN IF NOT EXISTS building TEXT DEFAULT 'Main Building';
    ALTER TABLE hotel_rooms ADD COLUMN IF NOT EXISTS wing TEXT DEFAULT 'East Wing';
    ALTER TABLE hotel_rooms ADD COLUMN IF NOT EXISTS room_status TEXT DEFAULT 'VACANT_CLEAN';
    ALTER TABLE hotel_rooms ADD COLUMN IF NOT EXISTS is_out_of_order BOOLEAN DEFAULT FALSE;
    ALTER TABLE hotel_rooms ADD COLUMN IF NOT EXISTS maintenance_reason TEXT;
    ALTER TABLE hotel_rooms ADD COLUMN IF NOT EXISTS rate_plan_id TEXT;
    ALTER TABLE hotel_rooms ADD COLUMN IF NOT EXISTS inspected_by TEXT;
    ALTER TABLE hotel_rooms ADD COLUMN IF NOT EXISTS inspected_at TIMESTAMPTZ;

    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS reservation_status TEXT DEFAULT 'CONFIRMED';
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS guest_id TEXT;
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS rate_plan_id TEXT;
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'direct';
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS billing_instructions TEXT;
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS key_card_status TEXT DEFAULT 'ready';
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC DEFAULT 0;
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS early_check_in_fee NUMERIC DEFAULT 0;
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS late_checkout_fee NUMERIC DEFAULT 0;
    ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS master_folio_id TEXT;

    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS station_id TEXT;
    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS station_code TEXT DEFAULT 'kitchen';
    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'NORMAL';
    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS sla_minutes INTEGER DEFAULT 20;
    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS fired_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;
    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS served_at TIMESTAMPTZ;
    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ;
    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS recalled_reason TEXT;
    ALTER TABLE kot_tickets ADD COLUMN IF NOT EXISTS reprint_count INTEGER DEFAULT 0;

    ALTER TABLE kot_items ADD COLUMN IF NOT EXISTS station_code TEXT DEFAULT 'kitchen';
    ALTER TABLE kot_items ADD COLUMN IF NOT EXISTS course TEXT DEFAULT 'main';
    ALTER TABLE kot_items ADD COLUMN IF NOT EXISTS chef_notes TEXT;
    ALTER TABLE kot_items ADD COLUMN IF NOT EXISTS bumped_at TIMESTAMPTZ;
    ALTER TABLE kot_items ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;
  `);
}

