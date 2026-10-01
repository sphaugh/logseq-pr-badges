import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { Badge, ErrorBadge, FallbackLink, Skeleton, safeHref } from "./badge";
import type { CacheEntry } from "./cache";

const entry = (o: Partial<CacheEntry> = {}): CacheEntry => ({
  state: "merged",
  title: "EMB-2887: Bringup and service rootfs",
  url: "https://github.com/avride/av/pull/36812",
  fetchedAt: 0,
  ...o,
});

describe("safeHref", () => {
  it("returns an href prop for https", () => {
    expect(safeHref("https://x.test/1")).toEqual({ href: "https://x.test/1" });
  });
  it("returns no href prop for any other scheme", () => {
    expect(safeHref("javascript:alert(1)")).toEqual({});
    expect(safeHref("JavaScript:alert(1)")).toEqual({});
    expect(safeHref("  https://x.test/1")).toEqual({});
    expect(safeHref("http://x.test/1")).toEqual({});
    expect(safeHref("data:text/html,x")).toEqual({});
  });
});

describe("Badge", () => {
  it("carries the state as a data attribute", () => {
    expect(
      render(
        <Badge entry={entry()} refKey={"avride/av#36812"} stale={false} />,
      ),
    ).toContain('data-state="merged"');
  });

  it("links to the pull request and opens outside Logseq", () => {
    const html = render(
      <Badge entry={entry()} refKey={"avride/av#36812"} stale={false} />,
    );
    expect(html).toContain('href="https://github.com/avride/av/pull/36812"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("shows the title", () => {
    expect(
      render(
        <Badge entry={entry()} refKey={"avride/av#36812"} stale={false} />,
      ),
    ).toContain("EMB-2887: Bringup and service rootfs");
  });

  it("escapes a hostile title", () => {
    const html = render(
      <Badge
        entry={entry({ title: "<script>alert(1)</script>" })}
        refKey={"k"}
        stale={false}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script>");
  });

  it("escapes a hostile tooltip", () => {
    const html = render(
      <Badge entry={entry()} refKey={'a/b#1" onmouseover="x'} stale={false} />,
    );
    expect(html).not.toContain('onmouseover="x"');
    expect(html).toContain("&quot;");
  });

  it("drops the href for a non-https url so javascript: cannot execute", () => {
    const html = render(
      <Badge
        entry={entry({ url: "javascript:alert(1)" })}
        refKey={"k"}
        stale={false}
      />,
    );
    expect(html).not.toContain("href");
    expect(html).not.toContain("javascript:");
  });

  it("marks a stale badge and omits the marker when fresh", () => {
    expect(
      render(<Badge entry={entry()} refKey={"k"} stale={true} />),
    ).toContain('data-stale="true"');
    expect(
      render(<Badge entry={entry()} refKey={"k"} stale={false} />),
    ).not.toContain("data-stale");
  });

  it("renders a distinct icon per state", () => {
    const all = (["open", "draft", "merged", "closed"] as const).map((s) =>
      render(<Badge entry={entry({ state: s })} refKey={"k"} stale={false} />),
    );
    expect(new Set(all).size).toBe(4);
  });

  it("names the state and ref in the title attribute", () => {
    const html = render(
      <Badge entry={entry()} refKey={"avride/av#36812"} stale={false} />,
    );
    expect(html).toMatch(/title="merged · avride\/av#36812"/);
  });

  it("emits no colour values — those live in the stylesheet", () => {
    const html = render(<Badge entry={entry()} refKey={"k"} stale={false} />);
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it("escapes a hostile https url inside the href", () => {
    const html = render(
      <Badge
        entry={entry({ url: 'https://x.test/"><script>alert(1)</script>' })}
        refKey={"k"}
        stale={false}
      />,
    );
    expect(html).toContain("href=");
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;");
  });
});

describe("Skeleton", () => {
  it("marks itself busy and shows the ref", () => {
    const html = render(<Skeleton refKey={"avride/av#36812"} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("avride/av#36812");
  });
});

describe("ErrorBadge", () => {
  it("shows a warning sign and escapes the message", () => {
    const html = render(<ErrorBadge message={"bad <ref>"} />);
    expect(html).toContain("⚠");
    expect(html).toContain("&lt;ref>");
    expect(html).not.toContain("<ref>");
  });
});

describe("FallbackLink", () => {
  it("keeps the ref visible and links to GitHub", () => {
    const html = render(
      <FallbackLink
        refKey={"avride/av#36812"}
        url={"https://github.com/avride/av/pull/36812"}
        message={"offline"}
      />,
    );
    expect(html).toContain("avride/av#36812");
    expect(html).toContain('href="https://github.com/avride/av/pull/36812"');
    expect(html).toContain("⚠");
  });
  it("puts the failure message in the tooltip, escaped", () => {
    const html = render(
      <FallbackLink
        refKey={"k"}
        url={"https://x.test/1"}
        message={"bad <token>"}
      />,
    );
    expect(html).toContain("&lt;token>");
    expect(html).not.toContain("<token>");
  });
  it("drops the href for a non-https url", () => {
    const html = render(
      <FallbackLink
        refKey={"k"}
        url={"javascript:alert(1)"}
        message={"nope"}
      />,
    );
    expect(html).not.toContain("href");
    expect(html).not.toContain("javascript:");
  });

  it("escapes a hostile https url inside the href", () => {
    const html = render(
      <FallbackLink
        refKey={"k"}
        url={'https://x.test/"><script>alert(1)</script>'}
        message={"boom"}
      />,
    );
    expect(html).toContain("href=");
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;");
  });
});
