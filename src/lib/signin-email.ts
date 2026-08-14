/**
 * The sign-in email.
 *
 * Auth.js sends a perfectly good default message, and it has one omission that
 * matters: it never says the link expires. Ours dies in fifteen minutes by
 * design, so a reader who comes back to it after twenty gets an unexplained
 * failure. That reads as a broken app rather than a working safeguard — the
 * security was fine, the silence was the bug.
 *
 * Written to email's constraints, not the web's, which is why the markup looks
 * twenty years old:
 *
 *  - **Tables, not flex or grid.** Outlook renders through Word, which supports
 *    neither; a div layout collapses to a single column there.
 *  - **Inline styles only.** Gmail strips <style> blocks in some clients,
 *    notably the mobile apps reading a forwarded message.
 *  - **No images.** Blocked by default nearly everywhere, so nothing
 *    load-bearing can be one — the button is a styled link, not a picture.
 *  - **The URL repeated as plain text.** Some clients mangle or refuse styled
 *    links, and a sign-in email that cannot be used is worse than an ugly one.
 *  - **A plain-text part.** Not courtesy: a message without one scores worse
 *    with spam filters, and this one has to arrive.
 *
 * Convention borrowed from the 1-percent-more-fluent agent, who hit the same
 * gap and wrote it up first.
 */
import { PRODUCT } from "@/config/product";

/**
 * How long a link lives, in minutes.
 *
 * THE ONE CONSTANT. `src/auth.ts` imports this to mint the token, and the copy
 * below states it. Two constants drift silently: an email promising fifteen
 * minutes for a token that dies in five teaches people the app is broken, and
 * nothing anywhere reports a problem. Same shape as the deploy's env check —
 * ask the question once, in the place that owns the answer.
 */
export const LINK_MINUTES = 15;

/** The light palette from globals.css. Email clients cannot be trusted with
 *  CSS variables, and several ignore prefers-color-scheme entirely, so these
 *  are literals and the backgrounds are always set explicitly. */
const INK = "#131a16";
const MUTED = "#57635c";
const RULE = "#cbd3cb";
const PAPER = "#f4f6f3";
const CARRY = "#0e6e62";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type SigninEmail = { subject: string; html: string; text: string };

/**
 * Builds both parts of the message. Pure — no key, no network — so the check
 * script can assert on it without sending anything.
 */
export function signinEmail(url: string): SigninEmail {
  // The URL carries a token and a callbackUrl, so it always contains "&".
  // Unescaped in an href that is a malformed entity, and some clients will
  // truncate the token at that point — which looks exactly like an expired
  // link. Escaped once here, decoded by the mail client, back to the original.
  const href = escapeHtml(url);

  const subject = `Your ${PRODUCT.name} sign-in link`;
  const expiry = `This link expires in ${LINK_MINUTES} minutes and can be used once.`;

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background-color:${PAPER};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAPER};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#ffffff;border:1px solid ${RULE};">
        <tr>
          <td style="padding:28px 28px 0 28px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;color:${INK};">
            ${escapeHtml(PRODUCT.name)}
          </td>
        </tr>
        <tr>
          <td style="padding:14px 28px 0 28px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:${INK};">
            Click below to sign in. If you didn&rsquo;t ask for this, ignore it &mdash; nothing happens until the link is opened.
          </td>
        </tr>
        <tr>
          <td style="padding:22px 28px 0 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${CARRY};">
                  <a href="${href}" style="display:inline-block;padding:12px 22px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Sign in</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 28px 0 28px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:${MUTED};">
            ${escapeHtml(expiry)}
          </td>
        </tr>
        <tr>
          <td style="padding:18px 28px 0 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${MUTED};">
            If the button doesn&rsquo;t work, paste this into your browser:
            <br />
            <span style="font-family:Menlo,Consolas,monospace;font-size:12px;color:${INK};word-break:break-all;">${href}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:22px 28px 28px 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${MUTED};border-top:1px solid ${RULE};">
            ${escapeHtml(PRODUCT.host)}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = `${PRODUCT.name}

Click below to sign in. If you didn't ask for this, ignore it — nothing
happens until the link is opened.

${url}

${expiry}

${PRODUCT.host}
`;

  return { subject, html, text };
}

/**
 * Hands the message to Resend.
 *
 * Plain REST rather than the SDK: it is one POST, and a dependency that ships
 * its own retry and error types earns nothing here.
 *
 * Throwing on failure is deliberate and matches Auth.js's own behaviour — the
 * caller turns it into an error on the sign-in page. Returning quietly would
 * send the reader to "check your email" for a message that was never sent,
 * which is the worst of both: no email and no error.
 */
export async function sendVerificationRequest(params: {
  identifier: string;
  url: string;
  provider: { apiKey?: string; from?: string };
}): Promise<void> {
  const { identifier, url, provider } = params;
  const { subject, html, text } = signinEmail(url);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: provider.from, to: identifier, subject, html, text }),
  });

  if (!res.ok) {
    // Bounded: the body can be an HTML error page, and the whole thing would
    // otherwise land in the server log for every failure.
    throw new Error(`Resend refused the sign-in email: ${(await res.text()).slice(0, 300)}`);
  }
}
