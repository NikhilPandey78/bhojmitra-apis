import { z } from 'zod';

export const demoRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  restaurant_name: z.string().trim().min(1).max(160),
  email: z.string().email().max(254),
  phone: z.string().trim().min(5).max(30),
  city: z.string().trim().max(100).optional().nullable(),
  number_of_branches: z.coerce.number().int().min(1).max(1000).default(1),
  preferred_date: z.string().optional().nullable(),
  preferred_time: z.string().optional().nullable(),
  message: z.string().trim().max(2000).optional().nullable(),
});

export const ticketSchema = z.object({
  subject: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(80),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  message: z.string().trim().min(1).max(5000),
});
