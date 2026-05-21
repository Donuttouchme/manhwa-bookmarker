import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@manhwa/db';
import { markFirstUserAsAdmin } from './admin-bootstrap';

const TEST_PREFIX = 'admintest+';

async function makeUser(suffix: string) {
  return prisma.user.create({
    data: { email: `${TEST_PREFIX}${suffix}@example.com` },
  });
}

describe('markFirstUserAsAdmin', () => {
  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
  });
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
  });

  it('flags the only user as admin', async () => {
    const user = await makeUser('one');
    await markFirstUserAsAdmin(user.id);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.isAdmin).toBe(true);
  });

  it('does not flag a second user as admin', async () => {
    const first = await makeUser('first');
    await markFirstUserAsAdmin(first.id);
    const second = await makeUser('second');
    await markFirstUserAsAdmin(second.id);
    const updatedSecond = await prisma.user.findUniqueOrThrow({ where: { id: second.id } });
    expect(updatedSecond.isAdmin).toBe(false);
  });

  it('is idempotent on an existing admin', async () => {
    const user = await makeUser('idem');
    await markFirstUserAsAdmin(user.id);
    await markFirstUserAsAdmin(user.id);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.isAdmin).toBe(true);
  });
});
