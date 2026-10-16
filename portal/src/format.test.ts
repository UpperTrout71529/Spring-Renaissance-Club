import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, sized } from "./format";

describe("format", () => {
  it("is always en-US, whatever the browser language", () => {
    Object.defineProperty(navigator, "language", { value: "ru-RU", configurable: true });
    expect(formatDate("2026-10-02T09:00:00Z")).toBe("Oct 2, 2026");
    expect(formatMoney(123450)).toBe("$1,234.50");
    expect(formatMoney(8800, "USD")).toBe("$88.00");
  });

  it("asks the Shopify CDN for the displayed width", () => {
    expect(sized("https://cdn.shopify.com/p.jpg", 160)).toBe("https://cdn.shopify.com/p.jpg?width=160");
    expect(sized("https://cdn.shopify.com/p.jpg?v=1", 160)).toBe("https://cdn.shopify.com/p.jpg?v=1&width=160");
  });
});
