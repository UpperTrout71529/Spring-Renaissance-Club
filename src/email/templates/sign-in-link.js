// `sign_in_link` (spec §10.1, §11). Calm and short; one button.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

export function signInLinkEmail({ to, link, portalUrl }) {
  const subject = "Your sign-in link";
  const text = [
    "Sign in to your Spring Renaissance account:",
    "",
    link,
    "",
    "This link works once, for 15 minutes. If you didn't ask for it, you can ignore this email.",
    "It works on any device, so you can open it on your phone or your computer.",
    "",
    "Spring Renaissance",
    portalUrl,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#FBFBF9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBFBF9;">
<tr><td align="center" style="padding:48px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;">
<tr><td style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;padding-bottom:32px;">Spring Renaissance</td></tr>
<tr><td style="font-size:28px;line-height:32px;padding-bottom:16px;">Your sign-in link</td></tr>
<tr><td style="font-size:16px;line-height:24px;padding-bottom:32px;">Sign in to your Spring Renaissance account.</td></tr>
<tr><td style="padding-bottom:32px;"><a href="${esc(link)}" style="display:inline-block;background:#1a1a1a;color:#FBFBF9;text-decoration:none;font-size:16px;padding:14px 32px;">Sign in</a></td></tr>
<tr><td style="font-size:14px;line-height:20px;color:#555;padding-bottom:8px;">This link works once, for 15 minutes. If you didn't ask for it, you can ignore this email.</td></tr>
<tr><td style="font-size:14px;line-height:20px;color:#555;padding-bottom:32px;">It works on any device, so you can open it on your phone or your computer.</td></tr>
<tr><td style="font-size:12px;line-height:18px;color:#777;border-top:1px solid #e5e5e0;padding-top:16px;">Spring Renaissance · <a href="${esc(portalUrl)}" style="color:#777;">${esc(portalUrl.replace(/^https?:\/\//, ""))}</a></td></tr>
</table></td></tr></table></body></html>`;

  return { to, subject, text, html };
}
