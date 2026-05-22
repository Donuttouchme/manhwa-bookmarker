import { Decimal } from '@manhwa/db';
import { Card, CardContent } from '@/components/ui/card';

export interface SeriesCardData {
  id: string;
  title: string;
  coverUrl: string | null;
  sources: {
    id: string;
    sourceId: string;
    sourceUrl: string;
    lastReadChapter: Decimal;
    latestChapter: Decimal | null;
  }[];
}

function unreadFor(source: SeriesCardData['sources'][number]): number {
  if (!source.latestChapter) return 0;
  const diff = source.latestChapter.minus(source.lastReadChapter);
  return diff.greaterThan(0) ? diff.toNumber() : 0;
}

function maxUnread(series: SeriesCardData): number {
  return series.sources.reduce((max, s) => Math.max(max, unreadFor(s)), 0);
}

export function SeriesCard({ series }: { series: SeriesCardData }) {
  const unread = maxUnread(series);
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4">
        {series.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={series.coverUrl}
            alt=""
            className="h-16 w-12 flex-shrink-0 rounded object-cover"
          />
        ) : (
          <div className="h-16 w-12 flex-shrink-0 rounded bg-muted" />
        )}
        <div className="flex-1 min-w-0">
          <h3 className="truncate font-medium">{series.title}</h3>
          <p className="text-xs text-muted-foreground">
            {series.sources.length} source{series.sources.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex-shrink-0">
          {unread > 0 ? (
            <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-primary px-2 text-sm font-semibold text-primary-foreground">
              {unread}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">caught up</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
