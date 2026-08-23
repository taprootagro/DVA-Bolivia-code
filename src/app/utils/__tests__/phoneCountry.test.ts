import { describe, expect, it } from "vitest";
import {
  defaultDialForLanguage,
  formatPhoneForDisplay,
  formatStoredPhone,
  isValidProfilePhoneParts,
  matchDialFromInput,
  parsePhoneParts,
} from "../phoneCountry";

describe("parsePhoneParts", () => {
  it("splits +86 15012345678", () => {
    expect(parsePhoneParts("+86 15012345678", "591")).toEqual({
      dial: "86",
      national: "15012345678",
    });
  });

  it("splits compact E.164 +8615012345678", () => {
    expect(parsePhoneParts("+8615012345678", "1")).toEqual({
      dial: "86",
      national: "15012345678",
    });
  });

  it("treats 11-digit China mobile without plus as +86", () => {
    expect(parsePhoneParts("15012345678", "591")).toEqual({
      dial: "86",
      national: "15012345678",
    });
  });

  it("uses fallback when empty", () => {
    expect(parsePhoneParts("", "591")).toEqual({ dial: "591", national: "" });
  });

  it("parses Bolivia +591", () => {
    expect(parsePhoneParts("+59171234567", "86")).toEqual({
      dial: "591",
      national: "71234567",
    });
  });
});

describe("formatStoredPhone", () => {
  it("formats as +dial space national", () => {
    expect(formatStoredPhone("86", "15012345678")).toBe("+86 15012345678");
  });

  it("returns empty when national is empty", () => {
    expect(formatStoredPhone("86", "")).toBe("");
  });
});

describe("formatPhoneForDisplay", () => {
  it("inserts a space into compact E.164", () => {
    expect(formatPhoneForDisplay("+8615012345678")).toBe("+86 15012345678");
  });
});

describe("isValidProfilePhoneParts", () => {
  it("accepts China mobile", () => {
    expect(isValidProfilePhoneParts("86", "15012345678")).toBe(true);
  });

  it("rejects too-short national", () => {
    expect(isValidProfilePhoneParts("86", "123")).toBe(false);
  });

  it("allows empty national", () => {
    expect(isValidProfilePhoneParts("86", "")).toBe(true);
  });
});

describe("defaultDialForLanguage", () => {
  it("defaults Chinese to 86 and Spanish to Bolivia 591", () => {
    expect(defaultDialForLanguage("zh")).toBe("86");
    expect(defaultDialForLanguage("es")).toBe("591");
  });
});

describe("matchDialFromInput", () => {
  it("matches +86 to CN", () => {
    expect(matchDialFromInput("+86")).toEqual({ dial: "86", iso: "CN" });
  });

  it("matches 591 to BO", () => {
    expect(matchDialFromInput("591")).toEqual({ dial: "591", iso: "BO" });
  });

  it("keeps unknown digits without forcing a country", () => {
    expect(matchDialFromInput("999")).toEqual({ dial: "999", iso: "" });
  });
});
