import { describe, expect, it } from "vitest";
import { dayPart } from "./greeting";

describe("dayPart", () => {
  it("splits the day at 5, 12 and 18", () => {
    expect([4, 5, 11, 12, 17, 18, 23, 0].map(dayPart)).toEqual([
      "evening", "morning", "morning", "afternoon", "afternoon", "evening", "evening", "evening",
    ]);
  });
});
