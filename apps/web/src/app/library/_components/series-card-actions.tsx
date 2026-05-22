'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { advanceCursor, setCursor } from '../actions';

interface Props {
  seriesId: string;
  unread: number;
}

export function SeriesCardActions({ seriesId, unread }: Props) {
  const [pending, startTransition] = useTransition();

  function handleAdvance() {
    if (unread <= 0) return;
    startTransition(async () => {
      const result = await advanceCursor(seriesId, 1);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const snapshot = result.snapshot;
      toast.success('Marked 1 chapter read', {
        duration: 5_000,
        action: {
          label: 'Undo',
          onClick: () => {
            startTransition(async () => {
              const undo = await setCursor(snapshot);
              if (!undo.ok) toast.error(undo.error);
            });
          },
        },
      });
    });
  }

  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={handleAdvance}
      disabled={pending || unread <= 0}
      aria-label="Mark one chapter read"
    >
      <Plus className="mr-1 h-4 w-4" />
      Read 1
    </Button>
  );
}
