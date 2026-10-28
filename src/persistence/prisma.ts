import { Prisma, PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient };

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl, log: [{ emit: 'event', level: 'warn' }] });
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
