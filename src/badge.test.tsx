import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { Badge, ErrorBadge, FallbackLink, Skeleton } from "./badge";
import type { CacheEntry } from "./cache";
import { PrRef } from "./ref";

const entry = (o: Partial<CacheEntry> = {}): CacheEntry => ({
  state: "merged",
  title: "EMB-2887: Bringup and service rootfs",
  fetchedAt: 0,
  ...o,
});

const PR = new PrRef({ owner: "avride", repo: "av", number: 36812 });

/** Built directly, skipping the parser, to check that markup escapes what it is given. */
const HOSTILE = new PrRef({
  owner: 'a"><script>alert(1)</script>',
  repo: 'b" onmouseover="x',
  number: 1,
});

describe("Badge", () => {
  it("carries the state as a data attribute", () => {
    expect(render(<Badge entry={entry()} pr={PR} stale={false} />)).toContain(
      'data-state="merged"',
    );
  });

  it("links to the pull request and opens outside Logseq", () => {
    const html = render(<Badge entry={entry()} pr={PR} stale={false} />);
    expect(html).toContain('href="https://github.com/avride/av/pull/36812"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("shows the title", () => {
    expect(render(<Badge entry={entry()} pr={PR} stale={false} />)).toContain(
      "EMB-2887: Bringup and service rootfs",
    );
  });

  it("escapes a hostile title", () => {
    const html = render(
      <Badge
        entry={entry({ title: "<script>alert(1)</script>" })}
        pr={PR}
        stale={false}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script>");
  });

  it("escapes a hostile ref in the tooltip and the href", () => {
    const html = render(<Badge entry={entry()} pr={HOSTILE} stale={false} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('onmouseover="x"');
    expect(html).toContain("&quot;");
  });

  it("marks whether the badge is stale", () => {
    expect(render(<Badge entry={entry()} pr={PR} stale={true} />)).toContain(
      'data-stale="true"',
    );
    expect(render(<Badge entry={entry()} pr={PR} stale={false} />)).toContain(
      'data-stale="false"',
    );
  });

  it("renders a distinct icon per state", () => {
    const all = (["open", "draft", "merged", "closed"] as const).map((s) =>
      render(<Badge entry={entry({ state: s })} pr={PR} stale={false} />),
    );
    expect(new Set(all).size).toBe(4);
  });

  it("names the state and ref in the title attribute", () => {
    const html = render(<Badge entry={entry()} pr={PR} stale={false} />);
    expect(html).toMatch(/title="merged · avride\/av#36812"/);
  });

  it("emits no colour values — those live in the stylesheet", () => {
    const html = render(<Badge entry={entry()} pr={PR} stale={false} />);
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

describe("Skeleton", () => {
  it("marks itself busy and shows the ref", () => {
    const html = render(<Skeleton pr={PR} />);
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
    const html = render(<FallbackLink pr={PR} message={"offline"} />);
    expect(html).toContain("avride/av#36812");
    expect(html).toContain('href="https://github.com/avride/av/pull/36812"');
    expect(html).toContain("⚠");
  });

  it("puts the failure message in the tooltip, escaped", () => {
    const html = render(<FallbackLink pr={PR} message={"bad <token>"} />);
    expect(html).toContain("&lt;token>");
    expect(html).not.toContain("<token>");
  });

  it("escapes a hostile ref in the href", () => {
    const html = render(<FallbackLink pr={HOSTILE} message={"boom"} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('onmouseover="x"');
  });
});
