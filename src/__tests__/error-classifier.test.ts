import { describe, it, expect } from "vitest";
import { classifyError } from "../agent/error-classifier.js";

describe("classifyError", () => {
  it("classifies provider quota/credit exhaustion as funding (not fatal)", () => {
    for (const msg of [
      "Inference error (openai): 429: insufficient_quota",
      "You exceeded your current quota, please check your plan and billing details.",
      "402 Payment Required",
      "no credits remaining",
    ]) {
      const c = classifyError(new Error(msg));
      expect(c.category).toBe("funding");
      expect(c.retryable).toBe(false);
      expect(c.backoffMs).toBeGreaterThan(0);
    }
  });

  it("classifies throttling as rate_limit (retryable)", () => {
    for (const msg of ["429 Too Many Requests", "rate limit exceeded", "model overloaded"]) {
      const c = classifyError(new Error(msg));
      expect(c.category).toBe("rate_limit");
      expect(c.retryable).toBe(true);
    }
  });

  it("classifies network/infra hiccups as transient (retryable)", () => {
    for (const msg of [
      "Circuit breaker is open until 2026-06-14T08:37:36.111Z",
      "ETIMEDOUT",
      "ECONNRESET",
      "fetch failed",
      "503 Service Unavailable",
      "socket hang up",
    ]) {
      const c = classifyError(new Error(msg));
      expect(c.category).toBe("transient");
      expect(c.retryable).toBe(true);
    }
  });

  it("treats unknown/code errors as fatal (the conservative default)", () => {
    const c = classifyError(new TypeError("Cannot read properties of undefined (reading 'foo')"));
    expect(c.category).toBe("fatal");
    expect(c.retryable).toBe(false);
  });

  it("handles non-Error inputs without throwing", () => {
    expect(classifyError("insufficient_quota").category).toBe("funding");
    expect(classifyError(null).category).toBe("fatal");
    expect(classifyError(undefined).category).toBe("fatal");
  });
});
