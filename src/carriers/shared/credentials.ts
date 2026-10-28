import { z } from 'zod';
import { Secret } from '../../lib/secret.js';

export interface UsernamePasswordCredentials {
  username: string;
  password: Secret<string>;
}

/** Username/password credentials. The password is wrapped in Secret immediately on parse. */
export const usernamePasswordSchema: z.ZodType<UsernamePasswordCredentials> = z.strictObject({
  username: z.string().trim().min(1).max(256),
  password: z
    .string()
    .min(1)
    .max(256)
    .transform((value) => new Secret(value)),
});

export const USERNAME_PASSWORD_FIELDS = [
  { name: 'username', label: 'Username', secret: false },
  { name: 'password', label: 'Password', secret: true },
];
