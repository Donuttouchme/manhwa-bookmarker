import { requireUser } from '@/lib/auth-helpers';
import { signOut } from '../../../auth';
import { Button } from '@/components/ui/button';

export default async function LibraryPage() {
  const user = await requireUser();

  async function handleSignOut() {
    'use server';
    await signOut({ redirectTo: '/signin' });
  }

  return (
    <main className="container mx-auto flex min-h-screen flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Library</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">
            {user.email}
            {(user as { isAdmin?: boolean }).isAdmin ? ' · admin' : ''}
          </span>
          <form action={handleSignOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <section className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-muted-foreground">
          Your library is empty. Series will appear here once you add them (Plan 2).
        </p>
      </section>
    </main>
  );
}
