import { describe, it, expect } from "vitest";
import { isProductionBuild } from "../productionGuard";

describe("isProductionBuild", () => {
  it("returns false in vitest (non-production) environment", () => {
    expect(isProductionBuild()).toBe(false);
  });
});
