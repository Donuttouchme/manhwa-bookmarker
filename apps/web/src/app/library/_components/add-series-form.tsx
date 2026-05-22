'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from 'sonner';
import { resolveSeriesByUrl, addSeries, type CursorInitMode } from '../actions';
import type { ResolvedSeries } from '@manhwa/sources';

type Phase =
  | { kind: 'input' }
  | {
      kind: 'preview';
      resolved: ResolvedSeries;
      attachCandidate: { id: string; title: string } | null;
    };

export function AddSeriesForm({ onSuccess }: { onSuccess?: () => void }) {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [cursorMode, setCursorMode] = useState<CursorInitMode>('caught-up');
  const [atChapter, setAtChapter] = useState('');
  const [attachToExisting, setAttachToExisting] = useState(true);
  const [pending, startTransition] = useTransition();

  function handleResolve() {
    startTransition(async () => {
      const result = await resolveSeriesByUrl(url);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setPhase({
        kind: 'preview',
        resolved: result.resolved,
        attachCandidate: result.candidateAttachTo
          ? { id: result.candidateAttachTo.id, title: result.candidateAttachTo.title }
          : null,
      });
    });
  }

  function handleAdd() {
    if (phase.kind !== 'preview') return;
    const previewState = phase;
    startTransition(async () => {
      const result = await addSeries({
        url,
        cursorMode,
        atChapter: cursorMode === 'at-chapter' ? Number(atChapter) : undefined,
        attachToSeriesId:
          previewState.attachCandidate && attachToExisting
            ? previewState.attachCandidate.id
            : undefined,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Series added.');
      onSuccess?.();
    });
  }

  if (phase.kind === 'input') {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="add-series-url">Source URL</Label>
          <Input
            id="add-series-url"
            type="url"
            placeholder="https://bato.to/title/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
            disabled={pending}
            required
          />
          <p className="text-xs text-muted-foreground">
            Paste the URL of the manga on a supported site (Bato.to, AsuraScans, ReaperScans, …).
          </p>
        </div>
        <Button onClick={handleResolve} disabled={!url || pending} className="w-full">
          {pending ? 'Resolving…' : 'Resolve'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-4">
        {phase.resolved.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={phase.resolved.coverUrl} alt="" className="h-32 w-24 rounded object-cover" />
        ) : (
          <div className="h-32 w-24 rounded bg-muted" />
        )}
        <div className="flex-1 space-y-1">
          <h3 className="font-semibold leading-tight">{phase.resolved.title}</h3>
          <p className="text-sm text-muted-foreground">
            Latest chapter:{' '}
            {phase.resolved.latestChapter ? phase.resolved.latestChapter.toString() : 'unknown'}
          </p>
        </div>
      </div>

      {phase.attachCandidate ? (
        <div className="rounded border border-dashed p-3 text-sm">
          <p className="mb-2">
            Looks like <strong>{phase.attachCandidate.title}</strong> from your library. Attach this
            source to it, or create a separate entry?
          </p>
          <RadioGroup
            value={attachToExisting ? 'attach' : 'separate'}
            onValueChange={(v) => setAttachToExisting(v === 'attach')}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id="attach-yes" value="attach" />
              <Label htmlFor="attach-yes">Attach to existing</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="attach-no" value="separate" />
              <Label htmlFor="attach-no">Create separate entry</Label>
            </div>
          </RadioGroup>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label>Initial reading progress</Label>
        <RadioGroup value={cursorMode} onValueChange={(v) => setCursorMode(v as CursorInitMode)}>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="cursor-caught-up" value="caught-up" />
            <Label htmlFor="cursor-caught-up">I'm caught up</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="cursor-at" value="at-chapter" />
            <Label htmlFor="cursor-at">I'm at chapter…</Label>
            <Input
              type="number"
              step="0.1"
              min="0"
              className="ml-2 w-24"
              value={atChapter}
              onChange={(e) => setAtChapter(e.target.value)}
              disabled={cursorMode !== 'at-chapter'}
            />
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="cursor-zero" value="from-zero" />
            <Label htmlFor="cursor-zero">Start from chapter 1</Label>
          </div>
        </RadioGroup>
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setPhase({ kind: 'input' })} disabled={pending}>
          Back
        </Button>
        <Button onClick={handleAdd} disabled={pending} className="flex-1">
          {pending ? 'Adding…' : 'Add to library'}
        </Button>
      </div>
    </div>
  );
}
