import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Skip Next internals and static files; run on everything else.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
