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
// as text.
//
// This counted occurrences of the token and wanted two or more — which two
// href attributes satisfy on their own, with the address readable nowhere.
// Reword the visible fallback to "click here" and the old form still passed.
// (The 1-percent-more-fluent agent found this in their copy; it was here too.)
//
// Strip every tag, and with it every attribute, then ask whether the address
// is still there. That is the actual property — a client that discards styling
// still shows you something you can paste — and it holds whether the fallback
// is a link or a paragraph.
const visibleText = html
  .replace(/<[^>]*>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"');
ok("the URL is still readable once every tag is stripped", visibleText.includes(URL_IN));

// ------------------------------------------------------- what it must say

for (const [part, body] of [["html", html], ["text", text]] as const) {
  // This asked whether the string "15" appeared anywhere in the body, and it
  // was VACUOUS: the HTML carries `font-size:15px`, so the assertion passed on
  // the stylesheet. The sentence could have drifted to five minutes, or been
  // deleted outright, with the check still green.
  //
  // Read every duration the message states and require them all to agree with
  // the constant. `length > 0` is the half that catches deletion; `every` is
  // the half that catches drift — including a hidden preheader disagreeing with
  // the visible sentence, which is the drift a reader cannot see.
  const stated = [...body.matchAll(/(\d+)\s*minutes?\b/g)].map((m) => Number(m[1]));
  ok(
    `${part}: states an expiry, and every duration stated is LINK_MINUTES`,
    stated.length > 0 && stated.every((n) => n === LINK_MINUTES),
  );
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
