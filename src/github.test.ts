import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { describe, expect } from "vitest";
import {
  AuthFailed,
  buildQuery,
  deriveState,
  GetPr,
  GitHubToken,
  isRetryable,
  makeResolver,
  messageFor,
  NetworkFailed,
  NotFound,
  type QueryFailed,
  RateLimited,
  retryPolicy,
} from "./github";
import { PrRef } from "./ref";

const REF_A = new PrRef({ owner: "avride", repo: "av", number: 36812 });
const REF_B = new PrRef({ owner: "avride", repo: "rootfs", number: 1780 });

/** Builds a layer whose `fetch` is the given stub, and runs `effect` provided
 *  with it, resolving `HttpClient` and handing it to `makeResolver` the same
 *  way the `Badges` service does in `index.ts`. */
const withStub = <A, E>(
  impl: (url: URL | string, init: RequestInit) => Promise<Response>,
  makeEffect: () => Effect.Effect<A, E, HttpClient.HttpClient>,
) => {
  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        FetchHttpClient.Fetch,
        impl as unknown as typeof globalThis.fetch,
      ),
    ),
  );
  return makeEffect().pipe(Effect.provide(layer));
};

/** The resolver under test, reading `token` and the client `withStub` provides. */
const resolverWith = (token = "tok") =>
  makeResolver.pipe(Effect.provideService(GitHubToken, token));

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const prNode = (over: Record<string, unknown> = {}) => ({
  title: "EMB-2887: Bringup",
  state: "OPEN",
  isDraft: true,
  ...over,
});

describe("deriveState", () => {
  it("maps MERGED to merged", () =>
    expect(deriveState("MERGED", false)).toBe("merged"));
  it("maps CLOSED to closed", () =>
    expect(deriveState("CLOSED", false)).toBe("closed"));
  it("maps OPEN + isDraft to draft", () =>
    expect(deriveState("OPEN", true)).toBe("draft"));
  it("maps OPEN to open", () =>
    expect(deriveState("OPEN", false)).toBe("open"));
  it("ignores isDraft once merged", () =>
    expect(deriveState("MERGED", true)).toBe("merged"));
});

describe("buildQuery", () => {
  it("gives each ref a distinct alias", () => {
    const q = buildQuery([REF_A, REF_B]);
    expect(q).toContain("a0: repository");
    expect(q).toContain("a1: repository");
    expect(q).toContain("pullRequest(number: 36812)");
    expect(q).toContain("pullRequest(number: 1780)");
  });

  it("quotes owner and repo as JSON strings", () => {
    expect(buildQuery([REF_A])).toContain('owner: "avride", name: "av"');
  });
});

describe("the resolver", () => {
  it.effect("issues ONE request for a concurrent batch", () => {
    let calls = 0;
    return withStub(
      async () => {
        calls += 1;
        return jsonResponse({
          data: {
            a0: { pullRequest: prNode() },
            a1: { pullRequest: prNode() },
          },
        });
      },
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith();
          const out = yield* Effect.forEach(
            [REF_A, REF_B],
            (ref) => Effect.request(new GetPr({ ref }), resolver),
            { concurrency: "unbounded" },
          );
          expect(out.length).toBe(2);
          // Without concurrency: 'unbounded' this would be 2. See task-5 corrections #5.
          expect(calls).toBe(1);
        }),
    );
  });

  it.effect(
    "pairs each alias with the right entry and mixes outcomes in one batch",
    () =>
      withStub(
        async () =>
          jsonResponse({
            data: {
              a0: {
                pullRequest: prNode({
                  title: "FIRST",
                  state: "MERGED",
                  isDraft: false,
                }),
              },
              a1: null,
            },
          }),
        () =>
          Effect.gen(function* () {
            const resolver = yield* resolverWith();
            const out = yield* Effect.forEach(
              [REF_A, REF_B],
              (ref) =>
                Effect.result(Effect.request(new GetPr({ ref }), resolver)),
              { concurrency: "unbounded" },
            );
            const [first, second] = out;
            expect(
              first && Result.isSuccess(first) && first.success,
            ).toMatchObject({ title: "FIRST", state: "merged" });
            expect(
              second && Result.isFailure(second) && second.failure._tag,
            ).toBe("NotFound");
          }),
      ),
  );

  it.effect("maps a successful response by ref", () =>
    withStub(
      async () =>
        jsonResponse({
          data: {
            a0: { pullRequest: prNode({ state: "OPEN", isDraft: true }) },
          },
        }),
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith();
          const data = yield* Effect.request(
            new GetPr({ ref: REF_A }),
            resolver,
          );
          expect(data).toEqual({
            state: "draft",
            title: "EMB-2887: Bringup",
          });
        }),
    ),
  );

  it.effect("fails a missing ref with NotFound", () =>
    withStub(
      async () => jsonResponse({ data: { a0: null } }),
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith();
          const r = yield* Effect.exit(
            Effect.request(new GetPr({ ref: REF_A }), resolver),
          );
          expect(Exit.isFailure(r)).toBe(true);
          const msg = yield* Effect.request(
            new GetPr({ ref: REF_A }),
            resolver,
          ).pipe(
            Effect.map(() => "ok"),
            Effect.catchTag("NotFound", (e: NotFound) =>
              Effect.succeed(`missing ${e.key}`),
            ),
            Effect.catch(() => Effect.succeed("other")),
          );
          expect(msg).toBe("missing avride/av#36812");
        }),
    ),
  );

  it.effect("classifies 401 as AuthFailed", () =>
    withStub(
      async () => jsonResponse({}, 401),
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith("bad");
          const msg = yield* Effect.request(
            new GetPr({ ref: REF_A }),
            resolver,
          ).pipe(
            Effect.map(() => "ok"),
            Effect.catchTag("AuthFailed", (e: AuthFailed) =>
              Effect.succeed(`auth ${e.status}`),
            ),
            Effect.catch(() => Effect.succeed("other")),
          );
          expect(msg).toBe("auth 401");
        }),
    ),
  );

  it.effect("classifies a thrown fetch as NetworkFailed", () =>
    withStub(
      async () => {
        throw new Error("offline");
      },
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith();
          const msg = yield* Effect.request(
            new GetPr({ ref: REF_A }),
            resolver,
          ).pipe(
            Effect.map(() => "ok"),
            Effect.catchTag("NetworkFailed", () => Effect.succeed("network")),
            Effect.catch(() => Effect.succeed("other")),
          );
          expect(msg).toBe("network");
        }),
    ),
  );

  it.effect("classifies a malformed body as QueryFailed", () =>
    withStub(
      async () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith();
          const msg = yield* Effect.request(
            new GetPr({ ref: REF_A }),
            resolver,
          ).pipe(
            Effect.map(() => "ok"),
            Effect.catchTag("QueryFailed", () => Effect.succeed("query")),
            Effect.catch(() => Effect.succeed("other")),
          );
          expect(msg).toBe("query");
        }),
    ),
  );

  // An empty 200 body decodes via `res.json` to `null` rather than throwing
  // `EmptyBodyError`, so without an explicit null-body guard this would fall
  // through the `body?.data == null` check (no `errors` array either) all the
  // way to the per-entry NotFound path -- which is wrong AND worse than wrong,
  // since index.ts then suppresses re-fetch for a ref that was never actually
  // looked up. See fix round 1, finding 1.
  it.effect(
    "classifies an empty response body as QueryFailed, not NotFound",
    () =>
      withStub(
        async () => new Response("", { status: 200 }),
        () =>
          Effect.gen(function* () {
            const resolver = yield* resolverWith();
            const msg = yield* Effect.request(
              new GetPr({ ref: REF_A }),
              resolver,
            ).pipe(
              Effect.map(() => "ok"),
              Effect.catchTag("QueryFailed", () => Effect.succeed("query")),
              Effect.catchTag("NotFound", () => Effect.succeed("not-found")),
              Effect.catch(() => Effect.succeed("other")),
            );
            expect(msg).toBe("query");
          }),
      ),
  );

  it.effect(
    "classifies a top-level errors response as QueryFailed, not NotFound",
    () =>
      withStub(
        async () =>
          jsonResponse({
            errors: [
              { message: "Query has complexity of 1000000, which exceeds max" },
            ],
          }),
        () =>
          Effect.gen(function* () {
            const resolver = yield* resolverWith();
            const msg = yield* Effect.request(
              new GetPr({ ref: REF_A }),
              resolver,
            ).pipe(
              Effect.map(() => "ok"),
              Effect.catchTag("QueryFailed", (e: QueryFailed) =>
                Effect.succeed(e.message),
              ),
              Effect.catch(() => Effect.succeed("other")),
            );
            expect(msg).toContain("complexity");
          }),
      ),
  );

  it.effect("reports retry-after when rate limited (429)", () =>
    withStub(
      async () => jsonResponse({}, 429, { "retry-after": "120" }),
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith();
          const ms = yield* Effect.request(
            new GetPr({ ref: REF_A }),
            resolver,
          ).pipe(
            Effect.map(() => -1),
            Effect.catchTag("RateLimited", (e: RateLimited) =>
              Effect.succeed(e.retryAfterMs),
            ),
            Effect.catch(() => Effect.succeed(-2)),
          );
          expect(ms).toBe(120_000);
        }),
    ),
  );

  it.effect("holds every later batch until the rate limit resets", () => {
    let calls = 0;
    return withStub(
      async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({}, 429, { "retry-after": "120" })
          : jsonResponse({ data: { a0: { pullRequest: prNode() } } });
      },
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith();
          const get = Effect.request(new GetPr({ ref: REF_A }), resolver);

          yield* Effect.exit(get);
          yield* TestClock.adjust("30 seconds");

          // Inside the window: fails locally with the time left, no request sent.
          const held = yield* Effect.flip(get);
          expect(held).toBeInstanceOf(RateLimited);
          expect((held as RateLimited).retryAfterMs).toBe(90_000);
          expect(calls).toBe(1);

          yield* TestClock.adjust("90 seconds");
          expect((yield* get).state).toBe("draft");
          expect(calls).toBe(2);
        }),
    );
  });

  it.effect("treats a 403 without rate-limit headers as AuthFailed", () => {
    let calls = 0;
    return withStub(
      async () => {
        calls += 1;
        return jsonResponse({}, 403, { "x-ratelimit-reset": "9999999999" });
      },
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith();
          const get = Effect.request(new GetPr({ ref: REF_A }), resolver);
          expect(yield* Effect.flip(get)).toBeInstanceOf(AuthFailed);
          // No rate-limit window opened: the next request still reaches GitHub.
          yield* Effect.flip(get);
          expect(calls).toBe(2);
        }),
    );
  });

  it.effect(
    "reads the retry delay from x-ratelimit-reset when retry-after is absent",
    () => {
      const resetSec = Math.floor(Date.now() / 1000) + 300;
      return withStub(
        async () =>
          jsonResponse({}, 403, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetSec),
          }),
        () =>
          Effect.gen(function* () {
            const resolver = yield* resolverWith();
            const ms = yield* Effect.request(
              new GetPr({ ref: REF_A }),
              resolver,
            ).pipe(
              Effect.map(() => -1),
              Effect.catchTag("RateLimited", (e: RateLimited) =>
                Effect.succeed(e.retryAfterMs),
              ),
              Effect.catch(() => Effect.succeed(-2)),
            );
            expect(ms).toBeGreaterThan(250_000);
            expect(ms).toBeLessThanOrEqual(300_000);
          }),
      );
    },
  );

  it.effect(
    "clamps an absurd x-ratelimit-reset to the maximum retry delay",
    () => {
      const resetSec = Math.floor(Date.now() / 1000) + 10 ** 9;
      return withStub(
        async () =>
          jsonResponse({}, 403, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetSec),
          }),
        () =>
          Effect.gen(function* () {
            const resolver = yield* resolverWith();
            const ms = yield* Effect.request(
              new GetPr({ ref: REF_A }),
              resolver,
            ).pipe(
              Effect.map(() => -1),
              Effect.catchTag("RateLimited", (e: RateLimited) =>
                Effect.succeed(e.retryAfterMs),
              ),
              Effect.catch(() => Effect.succeed(-2)),
            );
            expect(ms).toBeLessThanOrEqual(60 * 60 * 1000);
          }),
      );
    },
  );

  it.effect("sends the token as a bearer credential", () => {
    let seenAuth: string | undefined;
    return withStub(
      async (_url, init) => {
        const headers = init.headers as Record<string, string>;
        seenAuth = headers.Authorization ?? headers.authorization;
        return jsonResponse({ data: { a0: null } });
      },
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith("secret-token");
          yield* Effect.exit(
            Effect.request(new GetPr({ ref: REF_A }), resolver),
          );
          expect(seenAuth).toBe("Bearer secret-token");
        }),
    );
  });

  it.effect("never puts the token in an error message", () =>
    withStub(
      async () => {
        throw new Error("boom");
      },
      () =>
        Effect.gen(function* () {
          const resolver = yield* resolverWith("super-secret-token");
          const msg = yield* Effect.request(
            new GetPr({ ref: REF_A }),
            resolver,
          ).pipe(
            Effect.map(() => ""),
            Effect.catch((e) => Effect.succeed(JSON.stringify(e))),
          );
          expect(msg).not.toContain("super-secret-token");
        }),
    ),
  );

  it.effect(
    "strips a Bearer token that a caller smuggled into a network error message",
    () =>
      withStub(
        async () => {
          throw new Error("failed: Authorization: Bearer ghp_secret123");
        },
        () =>
          Effect.gen(function* () {
            const resolver = yield* resolverWith();
            const msg = yield* Effect.request(
              new GetPr({ ref: REF_A }),
              resolver,
            ).pipe(
              Effect.map(() => "ok"),
              Effect.catchTag("NetworkFailed", (e: NetworkFailed) =>
                Effect.succeed(e.message),
              ),
              Effect.catch(() => Effect.succeed("other")),
            );
            expect(msg).not.toContain("ghp_secret123");
            expect(msg).not.toContain("Bearer ghp_");
          }),
      ),
  );
});

describe("retryPolicy", () => {
  it.effect("retries a NetworkFailed failure under TestClock", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const flaky = Effect.suspend(() => {
        attempts += 1;
        return attempts < 3
          ? Effect.fail(new NetworkFailed({ message: "connection reset" }))
          : Effect.succeed("recovered");
      });
      // A time-based Schedule never elapses on its own under TestClock, so the
      // retry is forked and the clock advanced. See task-5 corrections #1 and #7.
      const fiber = yield* Effect.forkChild(
        Effect.retry(flaky, {
          schedule: retryPolicy,
          times: 5,
          while: isRetryable,
        }),
      );
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toBe("recovered");
      expect(attempts).toBe(3);
    }),
  );

  it.effect("waits out a RateLimited failure's retryAfterMs", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const limited = Effect.suspend(() => {
        attempts += 1;
        return attempts < 2
          ? Effect.fail(new RateLimited({ retryAfterMs: 300_000, status: 403 }))
          : Effect.succeed("reset");
      });
      const fiber = yield* Effect.forkChild(
        Effect.retry(limited, { schedule: retryPolicy, while: isRetryable }),
      );
      // Well past the network backoff, still short of GitHub's stated reset.
      yield* TestClock.adjust("1 minute");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("5 minutes");
      expect(yield* Fiber.join(fiber)).toBe("reset");
      expect(attempts).toBe(2);
    }),
  );

  it.effect("does not retry a NotFound failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const always = Effect.suspend(() => {
        attempts += 1;
        return Effect.fail(new NotFound({ key: "avride/av#1" }));
      });
      const fiber = yield* Effect.forkChild(
        Effect.exit(
          Effect.retry(always, {
            schedule: retryPolicy,
            times: 5,
            while: isRetryable,
          }),
        ),
      );
      yield* TestClock.adjust("1 minute");
      const r = yield* Fiber.join(fiber);
      expect(Exit.isFailure(r)).toBe(true);
      expect(attempts).toBe(1);
    }),
  );

  it.effect("is bounded even when a caller omits `times`", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const alwaysFailing = Effect.suspend(() => {
        attempts += 1;
        return Effect.fail(new NetworkFailed({ message: "offline" }));
      });
      // No `times` here: retryPolicy itself must cap the recurrence count via
      // Schedule.upTo, or this would retry forever. See task-5 fix-round-1 #3.
      const fiber = yield* Effect.forkChild(
        Effect.exit(
          Effect.retry(alwaysFailing, {
            schedule: retryPolicy,
            while: isRetryable,
          }),
        ),
      );
      yield* TestClock.adjust("2 minutes");
      const r = yield* Fiber.join(fiber);
      expect(Exit.isFailure(r)).toBe(true);
      // upTo({ times: 2 }) caps schedule outputs at 2, so at most one initial
      // attempt plus 2 retries. The cap is deliberately this tight: the retry runs
      // while the user watches a skeleton, so the whole budget is under a second.
      expect(attempts).toBeLessThanOrEqual(3);
      expect(attempts).toBeGreaterThan(1);
    }),
  );
});

describe("messageFor", () => {
  it("names the key and both causes of a NotFound", () => {
    const msg = messageFor(new NotFound({ key: "avride/av#36812" }));
    expect(msg).toContain("avride/av#36812");
    expect(msg).toContain("exist");
    expect(msg).toContain("access");
  });
});
