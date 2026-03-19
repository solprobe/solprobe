import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  isAvailable,
  recordSuccess,
  recordFailure,
  _resetBreakers,
  type SourceName,
} from "../src/circuitBreaker.js";

const SRC: SourceName = "rugcheck";

describe("circuitBreaker", () => {
  beforeEach(() => _resetBreakers());
  afterEach(() => vi.restoreAllMocks());

  it("starts CLOSED and allows requests", () => {
    expect(isAvailable(SRC)).toBe(true);
  });

  it("stays CLOSED for fewer than 5 failures", () => {
    for (let i = 0; i < 4; i++) recordFailure(SRC);
    expect(isAvailable(SRC)).toBe(true);
  });

  it("CLOSED → OPEN after exactly 5 failures", () => {
    for (let i = 0; i < 5; i++) recordFailure(SRC);
    expect(isAvailable(SRC)).toBe(false);
  });

  it("OPEN rejects immediately (0 ms cost — no retry logic called)", () => {
    for (let i = 0; i < 5; i++) recordFailure(SRC);
    // Confirm it is open at the same timestamp — no time advance needed
    expect(isAvailable(SRC)).toBe(false);
    expect(isAvailable(SRC)).toBe(false); // second call also instant-false
  });

  it("OPEN → HALF_OPEN after 60 s cooldown", () => {
    for (let i = 0; i < 5; i++) recordFailure(SRC);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    expect(isAvailable(SRC)).toBe(true); // transitions to HALF_OPEN → allows probe
  });

  it("HALF_OPEN → CLOSED on success", () => {
    for (let i = 0; i < 5; i++) recordFailure(SRC);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    isAvailable(SRC); // transitions to HALF_OPEN
    recordSuccess(SRC);
    vi.restoreAllMocks();

    // Should be fully CLOSED — 4 more failures should not open it
    for (let i = 0; i < 4; i++) recordFailure(SRC);
    expect(isAvailable(SRC)).toBe(true);
  });

  it("HALF_OPEN → OPEN on failure", () => {
    for (let i = 0; i < 5; i++) recordFailure(SRC);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    isAvailable(SRC); // transitions to HALF_OPEN
    recordFailure(SRC); // one more failure re-opens immediately
    vi.restoreAllMocks();

    expect(isAvailable(SRC)).toBe(false); // back to OPEN (openedAt = real now < 60s ago)
  });

  it("each source has independent state", () => {
    for (let i = 0; i < 5; i++) recordFailure("dexscreener");
    expect(isAvailable("dexscreener")).toBe(false);
    expect(isAvailable("helius_rpc")).toBe(true); // untouched
    expect(isAvailable("birdeye")).toBe(true);
  });
});
