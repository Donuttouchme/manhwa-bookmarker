import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <main className="container mx-auto flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">Manhwa Bookmarker</h1>
      <p className="text-muted-foreground">Tailwind + shadcn are wired up.</p>
      <Button>Hello</Button>
    </main>
  );
}
