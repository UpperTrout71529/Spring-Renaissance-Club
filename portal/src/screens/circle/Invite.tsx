// /circle/invite (docs/tz-v2-circle.md §11, §16; D31–D32): the personal link
// and code, the rules in one paragraph, this season's status, and the
// "paused" state when the economics do not allow a discount right now.

import { useState } from "preact/hooks";
import { copy } from "../../copy/en";
import { creditsText, seasonLabel, usd, type InviteData } from "../../circle-model";
import { ErrorState, Skeleton } from "../../ui/states";
import { SectionHeading } from "../Placeholder";
import { BackToCircle, copyText, useApi } from "./shared";

export function Invite() {
  const { state, reload } = useApi<InviteData>("/api/circle/invite");
  const [copied, setCopied] = useState(false);

  if (state.kind === "loading") return <><BackToCircle /><SectionHeading eyebrow={copy.eyebrows.circle} title={copy.invite.title} /><Skeleton lines={4} label={copy.invite.loading} /></>;
  if (state.kind === "error") {
    return (
      <>
        <BackToCircle />
        <SectionHeading eyebrow={copy.eyebrows.circle} title={copy.invite.title} />
        {state.status === 403
          ? <p class="circle-notice notice">{copy.invite.membersOnly}</p>
          : <ErrorState body={state.message} onRetry={reload} />}
      </>
    );
  }
  const d = state.data;
  return (
    <>
      <BackToCircle />
      <SectionHeading eyebrow={copy.eyebrows.circle} title={copy.invite.title} />
      <div class="circle-intro appear">
        {d.paused
          ? <p class="notice">{copy.invite.paused}</p>
          : <p>{copy.invite.rules(usd(d.discount_cents), creditsText(d.reward_cents))}</p>}
        <div class="field">
          <label for="invite-link">{copy.invite.linkLabel}</label>
          <input id="invite-link" readOnly value={d.link} onFocus={(e) => (e.target as HTMLInputElement).select()} />
        </div>
        <p class="small">{copy.invite.codeLabel(d.code)}</p>
        <div class="circle-actions">
          <button type="button" class="button button-primary" onClick={async () => setCopied(await copyText(d.link))}>{copy.invite.copyLink}</button>
          {copied && <span class="small" role="status">{copy.invite.copied}</span>}
        </div>
        <section class="circle-block" aria-labelledby="season-title">
          <h2 id="season-title" class="eyebrow">{copy.invite.seasonTitle(seasonLabel(d.season))}</h2>
          <p>{copy.invite.season[d.this_season] ?? copy.invite.season.none}</p>
        </section>
      </div>
    </>
  );
}
