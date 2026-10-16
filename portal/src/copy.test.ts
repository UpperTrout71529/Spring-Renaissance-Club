// Spec §3.4 / §6.9: UI strings live only in src/copy/en.ts. This guards the
// rule: JSX text nodes in components and screens must be expressions, not
// literal English.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return p.endsWith(".tsx") && !p.endsWith(".test.tsx") ? [p] : [];
  });
}

describe("copy", () => {
  it("has no literal text between JSX tags", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(join(__dirname))) {
      const src = readFileSync(file, "utf8");
      // >Some words<  — a text node that is not an {expression}. Code between
      // an arrow and a generic (=> x.has(y) ... api<T>) is excluded by refusing
      // the characters text nodes never need: ( ) ; =
      for (const m of src.matchAll(/>\s*([A-Za-z][^<>{}();=]*[A-Za-z.!?])\s*</g)) offenders.push(`${file}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });
});
