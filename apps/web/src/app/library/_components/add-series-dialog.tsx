'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Plus } from 'lucide-react';
import { AddSeriesForm } from './add-series-form';

export function AddSeriesDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" />
          Add series
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a series</DialogTitle>
          <DialogDescription>
            Paste a source URL. We'll resolve the title and chapter count.
          </DialogDescription>
        </DialogHeader>
        <AddSeriesForm onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
