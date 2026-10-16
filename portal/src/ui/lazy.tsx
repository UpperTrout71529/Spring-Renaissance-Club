// Screens loaded on first use (the V2 Circle): they stay out of the bundle
// that paints Home and sign-in (S11). A skeleton while the chunk loads; if it
// cannot load (offline, a deploy replaced it), the usual error with Try again.

import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { copy } from "../copy/en";
import { ErrorState, Skeleton } from "./states";

export function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>, label: string): ComponentType<P> {
  let Loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const start = () => (pending ??= load().then((c) => (Loaded = c)).catch((e) => { pending = null; throw e; }));

  return function Lazy(props: P) {
    const [, setTick] = useState(0);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (Loaded || failed) return;
      let live = true;
      start().then(() => live && setTick((n) => n + 1), () => live && setFailed(true));
      return () => { live = false; };
    }, [failed]);
    if (Loaded) return <Loaded {...props} />;
    if (failed) return <ErrorState body={copy.errors.network} onRetry={() => setFailed(false)} />;
    return <Skeleton lines={4} label={label} />;
  };
}
