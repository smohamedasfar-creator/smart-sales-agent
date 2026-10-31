import type { Settings } from "./db.js";

// The public privacy policy Meta asks for before a WhatsApp app can be published. It uses the business name and
// the business information from Settings, so it needs no editing.

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function privacyPage(settings: Settings, updated: string): string {
  const name = esc(settings.businessName || "Our company");
  const info = settings.businessInfo ? `<p>${esc(settings.businessInfo).replace(/\n/g, "<br>")}</p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy · ${name}</title>
<style>body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#1d2330;background:#fff}
h1{font-size:26px}h2{font-size:18px;margin-top:28px}.muted{color:#667085;font-size:14px}</style></head>
<body>
<h1>Privacy Policy</h1>
<p class="muted">${name}${settings.trn ? ` · TRN ${esc(settings.trn)}` : ""} · Last updated ${esc(updated)}</p>
<p>${name} ("we") answers price enquiries and orders sent to our WhatsApp Business number, with the help of an automated assistant. This policy explains what we collect when you message us and how we use it.</p>

<h2>What we collect</h2>
<ul>
<li>Your WhatsApp number and profile name.</li>
<li>The messages you send us and our replies.</li>
<li>Details you give us for quotations and delivery: your name, company name, emirate or area, and VAT registration number (TRN).</li>
<li>Your enquiries, quotations and orders.</li>
</ul>

<h2>How we use it</h2>
<ul>
<li>To answer your questions, prepare quotations, take orders and arrange delivery.</li>
<li>To follow up on quotations you asked for.</li>
<li>To meet our accounting and tax obligations.</li>
</ul>
<p>We do not sell your information and we do not use it for advertising.</p>

<h2>Who processes it for us</h2>
<ul>
<li><strong>Meta (WhatsApp)</strong> delivers messages between you and us.</li>
<li><strong>Anthropic (Claude)</strong> provides the AI that reads your messages and writes our replies.</li>
<li><strong>Our hosting provider</strong> runs the software and stores the data.</li>
<li>Our suppliers receive product and quantity details when we check prices, but not your name or number.</li>
</ul>

<h2>How long we keep it</h2>
<p>We keep enquiries and orders for as long as needed to serve you and to meet legal record-keeping requirements in the UAE.</p>

<h2>Your choices and deleting your data</h2>
<p>You can ask us at any time what information we hold about you, to correct it, or to delete it. Send a WhatsApp message to our business number saying "delete my data", or contact us using the details below. We will confirm when it is done, except for records we must keep by law.</p>

<h2>Contact</h2>
<p>${name}</p>
${info}
</body></html>`;
}
