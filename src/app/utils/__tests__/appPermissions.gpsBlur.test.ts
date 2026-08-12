import { describe, it, expect } from "vitest";
import { blurGpsCoordinate } from "../appPermissions";

describe("blurGpsCoordinate", () => {
  it("rounds positive coordinates to 2 decimal places", () => {
    expect(blurGpsCoordinate(39.904211)).toBe(39.9);
    expect(blurGpsCoordinate(39.905)).toBe(39.91);
  });

  it("rounds negative coordinates to 2 decimal places", () => {
    expect(blurGpsCoordinate(-116.407396)).toBe(-116.41);
    expect(blurGpsCoordinate(-0.004)).toBeCloseTo(0, 5);
  });

  it("preserves valid boundary values", () => {
    expect(blurGpsCoordinate(90)).toBe(90);
    expect(blurGpsCoordinate(-90)).toBe(-90);
    expect(blurGpsCoordinate(180)).toBe(180);
    expect(blurGpsCoordinate(-180)).toBe(-180);
  });

  it("rounds boundary-adjacent values correctly", () => {
    expect(blurGpsCoordinate(89.9994)).toBe(90);
    expect(blurGpsCoordinate(-179.9996)).toBe(-180);
  });
});
