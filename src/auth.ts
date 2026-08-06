import NextAuth, { type NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { PRODUCT } from "@/config/product";
import { SqliteAdapter } from "@/lib/store/adapter";
import { getUserById, touchUser } from "@/lib/store/db";

/**
 * Sign-in.
 *
 * Magic link plus OAuth, and no passwords anywhere. Passwords would not have
 * avoided the email dependency — "forgot password" is an email — they would
 * only have added hashing, reset tokens and credential-stuffing defence on top
 * of it.
 *
 * Sessions are JWTs, so there is no session table and no database round-trip
 * per request. The usual cost of that is being unable to revoke a session;
 * `token_version` below buys it back.
 *
 * Providers are registered only when configured, so a missing key means one
 * fewer button rather than a crash on boot.
 */
const providers: NextAuthConfig["providers"] = [];

if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
    }),
  );
}

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  );
}

if (process.env.AUTH_RESEND_KEY) {
  providers.push(
    Resend({
      apiKey: process.env.AUTH_RESEND_KEY,
      // Must be on a domain VERIFIED in Resend. A subdomain is a separate
      // domain there and needs its own DNS records — sending from
      // login@career-side-quests.gtfoo.com while only gtfoo.com is verified
      // fails, and the symptom is simply that no email ever arrives.
      from: process.env.AUTH_EMAIL_FROM ?? "login@gtfoo.com",
      name: `${PRODUCT.name} sign-in link`,
      // Short-lived: a link that works for a day is a link that works for
      // whoever reads the inbox tomorrow.
      maxAge: 15 * 60,
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: SqliteAdapter(),
  providers,
  session: { strategy: "jwt" },
  pages: { signIn: "/signin", verifyRequest: "/signin/check-email" },
  callbacks: {
    /**
     * Carry the user id and a token version in the JWT. The version is compared
     * against the database on every request, which is what makes "sign out
     * everywhere" possible without storing sessions: bumping the column
     * invalidates every token already issued.
     */
    async jwt({ token, user }) {
      if (user?.id) {
        token.uid = user.id;
        token.tv = getUserById(user.id)?.token_version ?? 0;
        touchUser(user.id);
        return token;
      }
      if (typeof token.uid === "string") {
        const row = getUserById(token.uid);
        // Account deleted, or every session revoked.
        if (!row || row.token_version !== token.tv) return null;
      }
      return token;
    },

    async session({ session, token }) {
      if (typeof token.uid === "string") session.user.id = token.uid;
      return session;
    },
  },
});

/**
 * Is sign-in usable at all?
 *
 * Auth.js needs AUTH_SECRET even to READ a session, so calling auth() without
 * one throws MissingSecret on every render. Accounts are optional in this app,
 * so the absence of a secret means "no sign-in", not "broken app" — callers
 * check this before touching auth() rather than catching an exception.
 */
export function authConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET) && providers.length > 0;
}

/** Safe session read: null when auth is not configured, instead of throwing. */
export async function currentUser() {
  if (!authConfigured()) return null;
  return (await auth())?.user ?? null;
}
