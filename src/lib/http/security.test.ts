import { describe, expect, it } from "vitest";
import { isSameOrigin } from "./security";

const origin = "http://localhost:3000";
const req = (headers: Record<string, string>) => new Request(`${origin}/api/x`, { method: "POST", headers });

describe("isSameOrigin", () => {
  it("accepts our own origin", () => expect(isSameOrigin(req({ origin }), origin)).toBe(true));
  it("rejects other origins", () => expect(isSameOrigin(req({ origin: "https://evil.example" }), origin)).toBe(false));
  it("rejects a missing Origin header", () => expect(isSameOrigin(req({}), origin)).toBe(false));
});
