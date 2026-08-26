import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  jwtSecret: required('JWT_SECRET'),
  databaseUrl: required('DATABASE_URL'),
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM || 'BhojMitra <onboarding@resend.dev>',
  demoRecipient: process.env.DEMO_RECIPIENT_EMAIL || 'bhojmitra@gmail.com',
};
