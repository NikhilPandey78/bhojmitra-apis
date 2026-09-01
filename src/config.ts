import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || 'https://bhojmitra.in',
  jwtSecret: process.env.JWT_SECRET || required('JWT_SECRET'),
  databaseUrl: process.env.DATABASE_URL || required('DATABASE_URL'),
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM || 'BhojMitra <onboarding@resend.dev>',
  demoRecipient: process.env.DEMO_RECIPIENT_EMAIL || 'bhojmitra@gmail.com',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret_placeholder',
  myRestoUrl: process.env.MY_RESTO_URL || 'https://myresto.bhojmitra.in',
};
