// /terms/membership (spec v1.1 §14.1, T1): a DRAFT, clearly marked, built
// only from what has been decided. Every legal clause is a visible
// "[Text from counsel]" placeholder — nothing legal is invented here (P0.7).
// Public: it opens without signing in.

import { copy } from "../../copy/en";
import { SectionHeading } from "../Placeholder";
import "./circle-v2.css";

export function Terms() {
  return (
    <>
      <SectionHeading eyebrow={copy.eyebrows.circle} title={copy.terms.title} />
      <div class="terms appear">
        <div class="terms-draft" role="note">
          <p><strong>{copy.terms.draft}</strong></p>
          <p>{copy.terms.draftBody}</p>
        </div>
        {copy.terms.sections.map((s, i) => (
          <section key={s.title} aria-labelledby={`terms-${i}`}>
            <h2 id={`terms-${i}`}>{s.title}</h2>
            {s.lines.map((l) => <p key={l}>{l}</p>)}
            {s.counsel && <p class="terms-placeholder">{copy.terms.placeholder}</p>}
          </section>
        ))}
        <p class="small">{copy.terms.binding}</p>
      </div>
    </>
  );
}
