import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
    .refine((val) => val === undefined || (!isNaN(val) && val >= 1 && val <= 65535), {
      message: 'PORT must be a number between 1 and 65535',
    }),
  OAUTH_CALLBACK_PORT: z.string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 8080))
    .refine((val) => !isNaN(val) && val >= 1 && val <= 65535, {
      message: 'OAUTH_CALLBACK_PORT must be a number between 1 and 65535',
    }),
  NETSUITE_ACCOUNT_ID: z.string().optional(),
  NETSUITE_CLIENT_ID: z.string().optional(),
  NETSUITE_SESSION_PATH: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(envData: Record<string, string | undefined> = process.env): EnvConfig {
  const result = envSchema.safeParse(envData);
  if (!result.success) {
    console.error('❌ Environment validation failed:', JSON.stringify(result.error.format(), null, 2));
    throw new Error('Environment validation failed');
  }
  return result.data;
}
