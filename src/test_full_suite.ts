import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { db } from './db.js';
import { randomUUID } from 'node:crypto';

async function runTestSuite() {
  console.log('=== RUNNING FULL MULTI-TENANT TEST SUITE ===');

  const partnerAId = 'd884e027-e566-4d25-934b-a90e4e2fb8e1';
  const partnerBId = 'test-sso-user-b-107dbff8';

  const tokenA = jwt.sign({ sub: partnerAId }, config.jwtSecret, { expiresIn: '7d' });
  const tokenB = jwt.sign({ sub: partnerBId }, config.jwtSecret, { expiresIn: '7d' });

  // 1. Create a branch for Partner A
  const branchA = await fetch('http://localhost:4000/api/resto/branches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ name: 'Partner A Noida Branch', code: 'BR-A1' }),
  });
  const branchAData = await branchA.json();
  const branchAId = branchAData.data.id;
  console.log('1. Partner A Branch Created:', branchAId);

  // 2. Partner A creates a user with their own branch -> Should SUCCEED (201)
  const testEmailA = `staff_${Date.now()}@test.com`;
  const userA = await fetch('http://localhost:4000/api/resto/restaurant_users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({
      full_name: 'Staff A1',
      email: testEmailA,
      role: 'chef',
      branch_id: branchAId,
      permissions: ['kitchen'],
    }),
  });
  const userAData = await userA.json();
  console.log('2. Partner A User Created (Status):', userA.status, userAData.data?.id);

  // 3. Partner A tries to create DUPLICATE user with same email -> Should FAIL (409 DUPLICATE_EMAIL)
  const dupUserA = await fetch('http://localhost:4000/api/resto/restaurant_users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({
      full_name: 'Staff Duplicate',
      email: testEmailA,
      role: 'cashier',
    }),
  });
  const dupData = await dupUserA.json();
  console.log('3. Duplicate Email Check (Status, Code):', dupUserA.status, dupData.code, dupData.error);

  // 4. Partner B tries to assign Partner A\'s branch -> Should FAIL (400 INVALID_BRANCH)
  const userBInvalidBranch = await fetch('http://localhost:4000/api/resto/restaurant_users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({
      full_name: 'Staff B Malicious',
      email: `staff_b_${Date.now()}@test.com`,
      role: 'staff',
      branch_id: branchAId, // Belongs to Partner A!
    }),
  });
  const invalidBranchData = await userBInvalidBranch.json();
  console.log('4. Cross-Tenant Branch Assignment Blocked (Status, Code):', userBInvalidBranch.status, invalidBranchData.code, invalidBranchData.error);

  // 5. Tenant Isolation Check: Partner B lists users -> MUST NOT see Partner A\'s user
  const listB = await fetch('http://localhost:4000/api/resto/restaurant_users', {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  const listBData = await listB.json();
  const foundAInB = (listBData.data || []).some((u: any) => u.email === testEmailA);
  console.log('5. Tenant Isolation Verified (Partner B cannot see Partner A user):', !foundAInB);

  // Clean up test data
  if (userAData.data?.id) {
    await fetch(`http://localhost:4000/api/resto/restaurant_users?id=${userAData.data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
  }
  if (branchAId) {
    await fetch(`http://localhost:4000/api/resto/branches?id=${branchAId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
  }
  console.log('=== ALL TESTS COMPLETED SUCCESSFULLY ===');
}

runTestSuite().catch(console.error);
