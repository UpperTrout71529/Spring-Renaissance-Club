import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, sized } from "./format";

describe("format", () => {
  it("is always en-US, whatever the browser language", () => {
    Object.defineProperty(navigator, "language", { value: "ru-RU", configurable: true });
    expect(formatDate("2026-10-02T09:00:00Z")).toBe("Oct 2, 2026");
    expect(formatMoney(123450)).toBe("$1,234.50");
    expect(formatMoney(8800, "USD")).toBe("$88.00");
  });

  it("keeps a date-only value on its day in every time zone", () => {
    expect(formatDate("2027-10-01")).toBe("Oct 1, 2027");
    const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "numeric" });
    // The bug this guards against: midnight UTC is still Sep 30 in New York.
    expect(ny.format(new Date("2027-10-01"))).toBe("30");
  });

  it("asks the Shopify CDN for the displayed width", () => {
    expect(sized("https://cdn.shopify.com/p.jpg", 160)).toBe("https://cdn.shopify.com/p.jpg?width=160");
    expect(sized("https://cdn.shopify.com/p.jpg?v=1", 160)).toBe("https://cdn.shopify.com/p.jpg?v=1&width=160");
  });
});
