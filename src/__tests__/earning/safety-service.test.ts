import { describe, it, expect } from "vitest";
import { assessTarget, safetyHandler } from "../../earning/safety-service.js";

describe("safety-service — the revenue engine's value logic", () => {
  it("classifies non-repo targets as unsupported (honest, not a fake 'safe')", async () => {
    const r = await assessTarget("0xdeadbeef");
    expect(r.type).toBe("unsupported");
    expect(r.safe).toBeNull();
    expect(r.risk).toBe("unknown");
  });

  it("empty target is handled, never 'safe'", async () => {
    const r = await assessTarget("   ");
    expect(r.safe).toBeNull();
  });

  it("handler requires ?target= and returns JSON", async () => {
    const h = safetyHandler();
    const miss = await h({ url: "/", method: "GET" });
    expect(miss.body).toContain("missing ?target");
    expect(miss.contentType).toBe("application/json");
  });

  it("always carries a disclaimer (never sells certainty)", async () => {
    const r = await assessTarget("not-a-repo-target");
    expect(r.disclaimer.toLowerCase()).toContain("research");
  });
});
