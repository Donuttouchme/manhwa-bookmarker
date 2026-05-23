import NextAuth from 'next-auth';
import Nodemailer from 'next-auth/providers/nodemailer';
import Google from 'next-auth/providers/google';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@manhwa/db';
import { authConfig } from './auth.config';
import { markFirstUserAsAdmin } from './src/lib/admin-bootstrap';

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'database' },
  providers: [
    Nodemailer({
      server: {
        host: process.env.EMAIL_SMTP_HOST,
        port: Number(process.env.EMAIL_SMTP_PORT ?? 1025),
        auth:
          process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS
            ? {
                user: process.env.EMAIL_SMTP_USER,
                pass: process.env.EMAIL_SMTP_PASS,
              }
            : undefined,
      },
      from: process.env.EMAIL_FROM,
    }),
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? '',
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? '',
    }),
  ],
  events: {
    async createUser({ user }) {
      if (!user.id) return;
      await markFirstUserAsAdmin(user.id);
    },
  },
  callbacks: {
    ...authConfig.callbacks,
    async session({ session, user }) {
      session.user.isAdmin = user.isAdmin ?? false;
      return session;
    },
  },
});
