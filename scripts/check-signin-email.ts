/**
 * The sign-in email, checked without sending one.
 *
 *   npm run check-signin-email
 *   PREVIEW=/tmp/signin.html npm run check-signin-email   # writes the markup
 *
 * No key, no network, no cost. Worth having because a fault here is invisible
 * from our side: nothing errors, nothing logs, and we find out because somebody
 * could not sign in and did not bother to say so.
 *
 * The assertions are the email-client constraints written down as tests, so
 * "improving" the markup into something that renders as one column in Outlook
 * fails here rather than in someone's inbox.
 */
import { writeFileSync } from "node:fs";

import { PRODUCT } from "../src/config/product";
import { LINK_MINUTES, signinEmail } from "../src/lib/signin-email";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`  ${name}`);
  }
}

// A realistic link: Auth.js always includes a token and a callbackUrl, so there
// is always at least one "&" and one URL-encoded ":" and "/".
const URL_IN =
  "https://career-side-quests.gtfoo.com/api/auth/callback/resend" +
  "?callbackUrl=https%3A%2F%2Fcareer-side-quests.gtfoo.com%2F" +
  "&token=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0&email=someone%40example.com";

const { subject, html, text } = signinEmail(URL_IN);

// -------------------------------------------------------------- the link

const href = /href="([^"]+)"/.exec(html)?.[1] ?? "";
const decoded = href
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"');

// The one that actually breaks sign-in. An unescaped "&" in an href is a
// malformed entity; some clients truncate the token there, and the symptom is
// indistinguishable from an expired link.
ok("the href round-trips back to the exact URL", decoded === URL_IN);
ok("the href escapes & as &amp;", href.includes("&amp;") && !/&(?!amp;|lt;|gt;|quot;)/.test(href));
ok("the token survives intact", decoded.includes("token=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"));

// Some clients refuse or mangle styled links, so the URL must also be readable
// as text. Two occurrences: the button and the paste-this fallback.
ok("the URL also appears as copyable text", (html.match(/a1b2c3d4e5f6/g) ?? []).length >= 2);

// ------------------------------------------------------- what it must say

for (const [part, body] of [["html", html], ["text", text]] as const) {
  ok(`${part}: states the expiry in minutes`, body.includes(String(LINK_MINUTES)));
  ok(`${part}: says the link is single use`, /once|single use/i.test(body));
  ok(`${part}: names the product`, body.includes(PRODUCT.name));
  ok(`${part}: tells an unexpecting reader they can ignore it`, /ignore/i.test(body));
}

ok("the subject names the product", subject.includes(PRODUCT.name));
ok("a plain-text part exists (a message without one scores worse with spam filters)", text.trim().length > 100);
ok("the plain-text part carries the raw, unescaped URL", text.includes(URL_IN));

// ------------------------------------------- what email clients throw away

// Each of these is a real client behaviour, not a style preference.
ok("no <img> — images are blocked by default nearly everywhere", !/<img\b/i.test(html));
ok("no <style> block — Gmail strips them in some clients", !/<style\b/i.test(html));
ok("no class attributes — there is no stylesheet to resolve them against", !/\sclass=/i.test(html));
ok("no flex or grid — Outlook renders through Word and supports neither", !/display:\s*(flex|grid)/i.test(html));
ok("layout is tables", (html.match(/<table\b/gi) ?? []).length >= 2);
ok("backgrounds are explicit — clients that auto-invert need something to keep", /background-color:/i.test(html));

// ----------------------------------------------------------------- output

if (process.env.PREVIEW) {
  writeFileSync(process.env.PREVIEW, html, "utf8");
  console.log(`preview written to ${process.env.PREVIEW}`);
}

console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nfailures:");
  console.log(failures.join("\n"));
}
process.exit(failed === 0 ? 0 : 1);
