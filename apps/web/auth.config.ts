import type { NextAuthConfig } from 'next-auth';

export const authConfig = {
  pages: {
    signIn: '/signin',
    verifyRequest: '/signin?verify=1',
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isOnSignin = nextUrl.pathname.startsWith('/signin');
      const isOnLibrary = nextUrl.pathname.startsWith('/library');

      if (isOnLibrary) return isLoggedIn;
      if (isOnSignin && isLoggedIn) {
        return Response.redirect(new URL('/library', nextUrl));
      }
      return true;
    },
  },
  providers: [], // Filled in by auth.ts (Node-only providers added there)
} satisfies NextAuthConfig;
