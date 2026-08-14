import NextAuth, { type NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Passkey from "next-auth/providers/passkey";
import Resend from "next-auth/providers/resend";
import { PRODUCT } from "@/config/product";
import { LINK_MINUTES, sendVerificationRequest } from "@/lib/signin-email";
import { SqliteAdapter } from "@/lib/store/adapter";
import { tokenVersion, touchUser } from "@/lib/store/db";

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
      //
      // Imported rather than written here, and that is the whole point: the
      // email states this number in words. Two constants drift silently, and a
      // message promising fifteen minutes for a token that dies in five
      // teaches people the app is broken with nothing reporting a fault.
      maxAge: LINK_MINUTES * 60,
      // Auth.js's default email never mentions that the link expires, so a
      // reader returning after twenty minutes gets an unexplained failure.
      sendVerificationRequest,
    }),
  );
}

/**
 * Passkeys, off unless asked for.
 *
 * Opt-in because WebAuthn is still experimental in Auth.js — it refuses to boot
 * without `experimental.enableWebAuthn` and warns on every start — and this is
 * an experimental feature inside a beta dependency. A flag means it can be
 * turned off without a deploy.
 *
 * A passkey is a convenience, not a replacement for the link. It lives on the
 * device, so it makes returning to a device you already use nearly instant; it
 * does NOT get you onto a new device, which is the thing accounts exist for
 * here. Email always works anywhere.
 */
const passkeysEnabled =
  Boolean(process.env.AUTH_PASSKEYS) && providers.length > 0;

if (passkeysEnabled) {
  providers.push(
    Passkey({
      /**
       * Refuse to mint an account from a passkey alone.
       *
       * The default returns `{ user: { email }, exists: false }` for an address
       * it has never seen, which registers a NEW account for it — with the
       * email unverified, because nothing was ever sent to it. That is an
       * account takeover waiting to happen: squat a passkey on someone's
       * address, wait for them to sign in by magic link, and Auth.js matches
       * them to the same row by email. Their account, your passkey.
       *
       * Returning null means registration is reachable only while already
       * signed in, so a passkey can only be ADDED by someone who has already
       * proved the address is theirs by receiving a link at it. Authenticating
       * with an existing passkey stays open.
       */
      getUserInfo: async (options, request) => {
        const email =
          request.method === "POST"
            ? (request.body?.email as string | undefined)
            : (request.query?.email as string | undefined);
        if (!email) return null;
        const user = await options.adapter?.getUserByEmail?.(email);
        return user ? { user, exists: true } : null;
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: SqliteAdapter(),
  providers,
  experimental: { enableWebAuthn: passkeysEnabled },
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
        token.tv = tokenVersion(user.id) ?? 0;
        touchUser(user.id);
        return token;
      }
      if (typeof token.uid === "string") {
        const tv = tokenVersion(token.uid);
        // null = account deleted; a mismatch = every session revoked. Both
        // invalidate, but they are different facts and collapsing them to 0
        // would let a deleted account's token keep working.
        if (tv === null || tv !== token.tv) return null;
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

/** Are passkeys on? Decides whether to offer them in the UI. */
export function passkeysConfigured(): boolean {
  return authConfigured() && passkeysEnabled;
}

/** Safe session read: null when auth is not configured, instead of throwing. */
export async function currentUser(): Promise<{
  id: string;
  email: string;
} | null> {
  if (!authConfigured()) return null;
  try {
    const user = (await auth())?.user;
    if (!user?.id) return null;
    return { id: user.id, email: user.email ?? "" };
  } catch (err) {
    // A session that cannot be read is a signed-out reader, not a broken page.
    console.error("session read failed", err);
    return null;
  }
}
