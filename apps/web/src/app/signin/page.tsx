import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { signIn, auth } from '../../../auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { checkRateLimit } from '@/lib/rate-limit';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ verify?: string; rate?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect('/library');

  const params = await searchParams;
  const showVerifyMessage = params.verify === '1';

  async function handleSignIn(formData: FormData) {
    'use server';
    const email = formData.get('email');
    if (typeof email !== 'string' || email.length === 0) return;

    const hdrs = await headers();
    const ip =
      hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      hdrs.get('x-real-ip') ??
      'unknown';

    const limit = await checkRateLimit({
      key: `auth-signin:${ip}`,
      limit: 5,
      windowMs: 60_000,
    });

    if (!limit.allowed) {
      // Auth.js doesn't natively surface a "rate limited" error to the form;
      // we redirect to a query-param state and render a message below.
      const { redirect } = await import('next/navigation');
      redirect('/signin?rate=1');
    }

    await signIn('nodemailer', { email, redirectTo: '/library' });
  }

  return (
    <main className="container mx-auto flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            We&apos;ll email you a one-time link. No password needed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {showVerifyMessage ? (
            <p className="text-sm text-muted-foreground">
              Check your email for a sign-in link. You can close this tab.
            </p>
          ) : (
            <form action={handleSignIn} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </div>
              <Button type="submit" className="w-full">
                Send magic link
              </Button>
            </form>
          )}
          {params.rate === '1' ? (
            <p className="text-sm text-destructive">
              Too many sign-in attempts. Wait a minute and try again.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
