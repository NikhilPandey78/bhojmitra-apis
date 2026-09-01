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
