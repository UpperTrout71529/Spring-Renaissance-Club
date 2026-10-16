// Shared frame for the account emails: calm, short, #FBFBF9, one optional
// button (spec §9.3, §11).

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

// paragraphs: plain strings; button: { label, url } | null.
export function renderEmail({ to, subject, heading, paragraphs, button = null, portalUrl }) {
  const text = [
    heading,
    "",
    ...paragraphs.flatMap((p) => [p, ""]),
    ...(button ? [`${button.label}: ${button.url}`, ""] : []),
    "Spring Renaissance",
    portalUrl,
  ].join("\n");

  const rows = paragraphs.map((p) =>
    `<tr><td style="font-size:16px;line-height:24px;padding-bottom:16px;">${esc(p)}</td></tr>`).join("");
  const action = button
    ? `<tr><td style="padding:16px 0 32px;"><a href="${esc(button.url)}" style="display:inline-block;background:#1a1a1a;color:#FBFBF9;text-decoration:none;font-size:16px;padding:14px 32px;">${esc(button.label)}</a></td></tr>`
    : "";
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#FBFBF9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBFBF9;">
<tr><td align="center" style="padding:48px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;">
<tr><td style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;padding-bottom:32px;">Spring Renaissance</td></tr>
<tr><td style="font-size:28px;line-height:32px;padding-bottom:16px;">${esc(heading)}</td></tr>
${rows}${action}
<tr><td style="font-size:12px;line-height:18px;color:#777;border-top:1px solid #e5e5e0;padding-top:16px;">Spring Renaissance · <a href="${esc(portalUrl)}" style="color:#777;">${esc(portalUrl.replace(/^https?:\/\//, ""))}</a></td></tr>
</table></td></tr></table></body></html>`;

  return { to, subject, text, html };
}
