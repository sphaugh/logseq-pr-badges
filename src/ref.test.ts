import { Effect, Equal, Result } from "effect";
import { describe, expect, it } from "vitest";
import { PrRef, parseRef as parseRefEffect } from "./ref";

const parseRef = (raw: string) =>
  Effect.runSync(Effect.result(parseRefEffect(raw)));

describe("parseRef", () => {
  it("accepts owner/repo#number", () => {
    expect(parseRef("avride/av#36812")).toEqual(
      Result.succeed({ owner: "avride", repo: "av", number: 36812 }),
    );
  });

  it("trims surrounding whitespace", () => {
    expect(parseRef("  avride/av#36812  ")).toEqual(
      Result.succeed({ owner: "avride", repo: "av", number: 36812 }),
    );
  });

  it("accepts dots, dashes and underscores in names", () => {
    expect(parseRef("some_owner/rootfs-setup.js#1780")).toEqual(
      Result.succeed({
        owner: "some_owner",
        repo: "rootfs-setup.js",
        number: 1780,
      }),
    );
  });

  it("rejects a bare number", () => {
    expect(parseRef("36812")._tag).toBe("Failure");
  });

  it("rejects a pull request URL", () => {
    expect(parseRef("https://github.com/avride/av/pull/36812")._tag).toBe(
      "Failure",
    );
  });

  it("rejects a missing owner", () => {
    expect(parseRef("av#36812")._tag).toBe("Failure");
  });

  it("rejects a missing number", () => {
    expect(parseRef("avride/av")._tag).toBe("Failure");
  });

  it("rejects a non-numeric number", () => {
    expect(parseRef("avride/av#abc")._tag).toBe("Failure");
  });

  it("rejects non-decimal number forms", () => {
    for (const n of ["1e3", "0x10", " 1", "1.0"])
      expect(parseRef(`avride/av#${n}`)._tag).toBe("Failure");
  });

  it("rejects zero", () => {
    expect(parseRef("avride/av#0")._tag).toBe("Failure");
  });

  it("rejects an empty string", () => {
    expect(parseRef("")._tag).toBe("Failure");
  });
});

describe("PrRef", () => {
  const ref = new PrRef({ owner: "avride", repo: "av", number: 36812 });

  it("renders the canonical key", () => {
    expect(ref.key).toBe("avride/av#36812");
  });

  it("links to the pull request", () => {
    expect(ref.url).toBe("https://github.com/avride/av/pull/36812");
  });

  it("normalizes leading zeros so the cache key is stable", () => {
    const parsed = parseRef("avride/av#007");
    expect(Result.map(parsed, (r) => r.key)).toEqual(
      Result.succeed("avride/av#7"),
    );
  });

  it("is equal to another ref to the same PR", () => {
    const same = new PrRef({ owner: "avride", repo: "av", number: 36812 });
    expect(Equal.equals(ref, same)).toBe(true);
  });
});
