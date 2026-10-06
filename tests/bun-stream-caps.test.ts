import { expect, test } from "bun:test";
import { isBunAsyncPullCancelUnsafe } from "../src/lib/bun-stream-caps.ts";

test("Bun async-pull cancellation gate is conservative", () => {
  expect(isBunAsyncPullCancelUnsafe("1.3.14")).toBe(true);
  expect(isBunAsyncPullCancelUnsafe("1.4.0-canary.3")).toBe(true);
  expect(isBunAsyncPullCancelUnsafe("1.4.0")).toBe(false);
  expect(isBunAsyncPullCancelUnsafe("2.0.0")).toBe(false);
  expect(isBunAsyncPullCancelUnsafe("unknown")).toBe(true);
});
