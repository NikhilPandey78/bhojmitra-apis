import { db } from './db.js';

async function auditIndexes() {
  console.log('Auditing PostgreSQL Database Indexes...\n');
  const res = await db.query(`
    SELECT
      tablename,
      indexname,
      indexdef
    FROM
      pg_indexes
    WHERE
      schemaname = 'public'
    ORDER BY
      tablename,
      indexname;
  `);

  console.log(`Found ${res.rows.length} indexes in public schema:`);
  const byTable: Record<string, string[]> = {};
  for (const row of res.rows) {
    if (!byTable[row.tablename]) byTable[row.tablename] = [];
    byTable[row.tablename].push(row.indexname);
  }

  for (const [tbl, idxs] of Object.entries(byTable)) {
    console.log(`- ${tbl}: ${idxs.join(', ')}`);
  }

  process.exit(0);
}

auditIndexes().catch(err => {
  console.error(err);
  process.exit(1);
});
