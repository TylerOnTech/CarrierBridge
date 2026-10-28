import { randomBytes } from 'node:crypto';

export const randomToken = (prefix: string): string => `${prefix}_${randomBytes(18).toString('base64url')}`;
