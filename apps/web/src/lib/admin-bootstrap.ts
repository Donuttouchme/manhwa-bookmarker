import { prisma } from '@manhwa/db';

/**
 * If this is the only user, flag them as admin. Idempotent — running it
 * on an existing admin is a no-op. Called from the Auth.js `createUser`
 * event right after a user is persisted.
 */
export async function markFirstUserAsAdmin(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const count = await tx.user.count();
    if (count !== 1) return;
    await tx.user.update({
      where: { id: userId },
      data: { isAdmin: true },
    });
  });
}
