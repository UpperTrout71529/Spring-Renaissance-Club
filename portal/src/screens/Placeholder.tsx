// Section screens are filled in by later tasks (S5–S9). Until then each shows
// only its heading — no invented content.

import { copy } from "../copy/en";
import { Link } from "../ui/Link";

export function SectionHeading({ eyebrow, title }: { eyebrow?: string; title: string }) {
  return (
    <header class="section-heading appear">
      {eyebrow && <p class="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
    </header>
  );
}

export function NotFound() {
  return (
    <section class="state appear">
      <h1>{copy.notFound.title}</h1>
      <p>{copy.notFound.body}</p>
      <div class="state-action">
        <Link href="/" class="button button-secondary">{copy.notFound.action}</Link>
      </div>
    </section>
  );
}
