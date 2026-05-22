import { requireUser } from '@/lib/auth-helpers';
import { signOut } from '../../../auth';
import { Button } from '@/components/ui/button';
import { AddSeriesDialog } from './_components/add-series-dialog';

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
        <div className="flex items-center gap-3">
          <AddSeriesDialog />
          <span className="text-sm text-muted-foreground">
            {user.email}
            {user.isAdmin ? ' · admin' : ''}
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
          Your library is empty. Click "Add series" to add your first one.
        </p>
      </section>
    </main>
  );
}
