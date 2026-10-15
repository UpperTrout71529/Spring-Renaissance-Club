// `step_up_code` (spec §11): six digits, ten minutes.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

export function stepUpCodeEmail({ to, code, portalUrl }) {
  const subject = "Your confirmation code";
  const text = [
    `Your Spring Renaissance confirmation code is ${code}.`,
    "",
    "It works for 10 minutes. If you didn't ask for it, you can ignore this email — your account stays as it is.",
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
<tr><td style="font-size:28px;line-height:32px;padding-bottom:16px;">Your confirmation code</td></tr>
<tr><td style="font-size:36px;line-height:44px;letter-spacing:0.2em;padding-bottom:24px;">${esc(code)}</td></tr>
<tr><td style="font-size:14px;line-height:20px;color:#555;padding-bottom:32px;">It works for 10 minutes. If you didn't ask for it, you can ignore this email — your account stays as it is.</td></tr>
<tr><td style="font-size:12px;line-height:18px;color:#777;border-top:1px solid #e5e5e0;padding-top:16px;">Spring Renaissance · <a href="${esc(portalUrl)}" style="color:#777;">${esc(portalUrl.replace(/^https?:\/\//, ""))}</a></td></tr>
</table></td></tr></table></body></html>`;

  return { to, subject, text, html };
}
