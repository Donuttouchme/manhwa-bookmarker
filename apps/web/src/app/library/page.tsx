import { requireUser } from '@/lib/auth-helpers';
import { signOut } from '../../../auth';
import { Button } from '@/components/ui/button';
import { prisma } from '@manhwa/db';
import { AddSeriesDialog } from './_components/add-series-dialog';
import { SeriesCard } from './_components/series-card';

export default async function LibraryPage() {
  const user = await requireUser();

  async function handleSignOut() {
    'use server';
    await signOut({ redirectTo: '/signin' });
  }

  const seriesRows = await prisma.series.findMany({
    where: { userId: user.id },
    include: {
      sources: {
        select: {
          id: true,
          sourceId: true,
          sourceUrl: true,
          lastReadChapter: true,
          latestChapter: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Sort by max-unread DESC (in-memory; small N for hobby use).
  const sorted = seriesRows.slice().sort((a, b) => {
    const aMax = Math.max(
      0,
      ...a.sources.map((s) =>
        s.latestChapter ? s.latestChapter.minus(s.lastReadChapter).toNumber() : 0,
      ),
    );
    const bMax = Math.max(
      0,
      ...b.sources.map((s) =>
        s.latestChapter ? s.latestChapter.minus(s.lastReadChapter).toNumber() : 0,
      ),
    );
    return bMax - aMax;
  });

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
      {sorted.length === 0 ? (
        <section className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground">
            Your library is empty. Click "Add series" to add your first one.
          </p>
        </section>
      ) : (
        <section className="space-y-3">
          {sorted.map((series) => (
            <SeriesCard key={series.id} series={series} />
          ))}
        </section>
      )}
    </main>
  );
}
