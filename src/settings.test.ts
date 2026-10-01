import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { decodeSettings } from "./settings";

describe("decodeSettings", () => {
  it("trims the token", () => {
    expect(decodeSettings({ token: "  ghp_x \n", ttlMinutes: 5 })).toEqual(
      Option.some({ token: "ghp_x", ttlMinutes: 5 }),
    );
  });

  it("is None when the token is missing, blank or not a string", () => {
    for (const raw of [
      undefined,
      {},
      { token: "" },
      { token: "   " },
      { token: 3 },
    ])
      expect(Option.isNone(decodeSettings(raw))).toBe(true);
  });

  it("defaults a missing or unusable refresh interval", () => {
    for (const ttlMinutes of [undefined, -1, "abc"])
      expect(decodeSettings({ token: "ghp_x", ttlMinutes })).toEqual(
        Option.some({ token: "ghp_x", ttlMinutes: 15 }),
      );
  });

  it("accepts a refresh interval stored as a string", () => {
    expect(decodeSettings({ token: "ghp_x", ttlMinutes: "7" })).toEqual(
      Option.some({ token: "ghp_x", ttlMinutes: 7 }),
    );
  });
});
