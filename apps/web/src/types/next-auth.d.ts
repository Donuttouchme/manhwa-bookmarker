import type { DefaultSession, DefaultUser } from 'next-auth';

declare module 'next-auth' {
  interface User extends DefaultUser {
    isAdmin?: boolean;
  }

  interface Session extends DefaultSession {
    user: DefaultSession['user'] & {
      id: string;
      isAdmin: boolean;
    };
  }
}
