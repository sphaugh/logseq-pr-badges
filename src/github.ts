import {
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  Ref,
  Request,
  RequestResolver,
  Result,
  Schedule,
} from "effect";
import {
  HttpBody,
  HttpClient,
  type HttpClientError,
} from "effect/unstable/http";
import type { PrState } from "./cache";
import type { PrRef } from "./ref";

export class NotFound extends Data.TaggedError("NotFound")<{ key: string }> {}
export class AuthFailed extends Data.TaggedError("AuthFailed")<{
  status: number;
}> {}
export class RateLimited extends Data.TaggedError("RateLimited")<{
  retryAfterMs: number;
  status: number;
}> {}
export class NetworkFailed extends Data.TaggedError("NetworkFailed")<{
  message: string;
}> {}
export class QueryFailed extends Data.TaggedError("QueryFailed")<{
  message: string;
}> {}

export type PrError =
  | NotFound
  | AuthFailed
  | RateLimited
  | NetworkFailed
  | QueryFailed;

export interface PrData {
  readonly state: PrState;
  readonly title: string;
}

const ENDPOINT = "https://api.github.com/graphql";
export const BATCH_MAX = 25;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export const deriveState = (state: string, isDraft: boolean): PrState => {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return isDraft ? "draft" : "open";
};

export const buildQuery = (refs: readonly PrRef[]): string => {
  const parts = refs.map(
    (r, i) =>
      `a${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) ` +
      `{ pullRequest(number: ${r.number}) { title state isDraft } }`,
  );
  return `query { ${parts.join(" ")} }`;
};

/** GitHub answers both a rate limit and a plain "forbidden" with 403. Only the
 *  rate limit says so in its headers: `retry-after` for a secondary limit,
 *  `x-ratelimit-remaining: 0` for the primary one. `x-ratelimit-reset` alone is not
 *  a signal; GitHub sends it on every response. */
const isRateLimit = (
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
): boolean =>
  status === 429 ||
  (status === 403 &&
    (headers["retry-after"] !== undefined ||
      headers["x-ratelimit-remaining"] === "0"));

/** `HttpClientResponse#headers` is a plain record keyed by lowercase header
 *  name (not a `Headers` object), so lookups are index access, not `.get()`. */
const retryAfterMsFrom = (
  headers: Readonly<Record<string, string | undefined>>,
): number => {
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
  }
  const reset = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) {
    const delta = reset * 1000 - Date.now();
    if (delta > 0) return Math.min(delta, MAX_RETRY_AFTER_MS);
  }
  return Math.min(60_000, MAX_RETRY_AFTER_MS);
};

/** Network errors are surfaced to the user; make sure a credential can never ride
 *  along in one, even from a caller that put it there. */
const sanitize = (m: string | undefined): string =>
  (m ?? "").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 200);

/** Maps every `HttpClient` failure onto our own tagged errors. All failures —
 *  transport and decode alike — share `_tag === 'HttpClientError'`, so the
 *  discriminant is `reason._tag`, not `kind` (that field exists only on
 *  `HttpClientErrorSchema`, a separate serialization type, not on `reason`). */
const toPrError = (error: HttpClientError.HttpClientError): PrError => {
  switch (error.reason._tag) {
    case "TransportError":
      return new NetworkFailed({
        message:
          sanitize((error.reason.cause as Error)?.message) ||
          "network request failed",
      });
    case "DecodeError":
    case "EmptyBodyError":
      return new QueryFailed({
        message: "GitHub returned a malformed response body.",
      });
    case "EncodeError":
    case "InvalidUrlError":
    case "StatusCodeError":
      // These indicate a bug on our side (bad URL, unencodable body, or a status
      // filter we do not apply) rather than anything GitHub or the network did.
      return new QueryFailed({
        message: "GitHub returned an unexpected client error.",
      });
  }
};

export class GetPr extends Request.TaggedClass("GetPr")<
  { readonly ref: PrRef },
  PrData,
  PrError
> {}

/** Bounded so a caller cannot forget `times` and retry forever. `upTo` caps an
 *  existing schedule's number of outputs while preserving its delay behaviour;
 *  `Schedule.recurs`/`compose` would replace the delay, not cap it.
 *
 *  A network failure gets a fraction of a second: enough for a DNS hiccup or a
 *  connection reset to succeed on a second attempt, nowhere near long enough to
 *  delay the fallback link. A rate limit instead waits out GitHub's stated reset;
 *  retrying any sooner only spends requests that cannot succeed. */
export const retryPolicy = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.setInputType<PrError>(),
  Schedule.modifyDelay(({ input, duration }) =>
    Effect.succeed(
      input._tag === "RateLimited" ? input.retryAfterMs : duration,
    ),
  ),
  Schedule.upTo({ times: 2 }),
);

export const isRetryable = (e: PrError): boolean =>
  e._tag === "NetworkFailed" || e._tag === "RateLimited";

/** What the user reads for each error. The errors carry structured data, not
 *  prose, so every sentence a badge can show lives here.
 *
 *  NotFound must name BOTH causes: GitHub answers a PR the token cannot see exactly
 *  as it answers one that does not exist, and naming only the first sends the user
 *  looking for a typo when the fault is the token's scope. */
export const messageFor = (error: PrError): string => {
  switch (error._tag) {
    case "NotFound":
      return `${error.key} not found. It may not exist, or the token may not have access to a private repository.`;
    case "RateLimited":
      return `GitHub rate limited the request (${error.status}); will retry when it resets.`;
    case "AuthFailed":
      return `GitHub rejected the token (${error.status}). Check the token in plugin settings.`;
    case "NetworkFailed":
      return error.message || "network request failed";
    case "QueryFailed":
      return error.message;
  }
};

/** The parts of a GraphQL response the resolver reads. A cast, not a validation:
 *  every field is read defensively below. */
interface GraphQLBody {
  readonly data?: Record<
    string,
    { readonly pullRequest?: Record<string, unknown> | null } | null
  > | null;
  readonly errors?: ReadonlyArray<{ readonly message?: unknown }>;
}

/** The GitHub token the plugin started with. */
export class GitHubToken extends Context.Service<GitHubToken, string>()(
  "logseq-pr-badges/GitHubToken",
) {}

/** The resolver owns the rate-limit window, because it is the only thing that
 *  talks to GitHub. After a 403/429, every batch until the reset fails locally with
 *  the time remaining, so `retryPolicy` waits out the same window for every PR
 *  instead of each one spending a request to discover it. */
export const makeResolver = Effect.gen(function* () {
  const token = yield* GitHubToken;
  const client = yield* HttpClient.HttpClient;
  const limited = yield* Ref.make({ until: 0, status: 0 });

  return RequestResolver.make<GetPr>((entries) =>
    Effect.gen(function* () {
      const refs = entries.map((e) => e.request.ref);

      const failAll = (e: PrError): void => {
        for (const entry of entries) entry.completeUnsafe(Exit.fail(e));
      };

      const now = yield* Clock.currentTimeMillis;
      const { until, status } = yield* Ref.get(limited);
      if (now < until) {
        return failAll(new RateLimited({ retryAfterMs: until - now, status }));
      }

      const fetched = yield* Effect.result(
        client.post(ENDPOINT, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          // jsonUnsafe's body carries its own `contentType` metadata
          // (`application/json`), so no explicit Content-Type header is needed.
          body: HttpBody.jsonUnsafe({ query: buildQuery(refs) }),
        }),
      );
      if (Result.isFailure(fetched)) {
        failAll(toPrError(fetched.failure));
        return;
      }
      const res = fetched.success;

      if (res.status === 401) return failAll(new AuthFailed({ status: 401 }));
      if (isRateLimit(res.status, res.headers)) {
        const retryAfterMs = retryAfterMsFrom(res.headers);
        yield* Ref.set(limited, {
          until: now + retryAfterMs,
          status: res.status,
        });
        return failAll(new RateLimited({ retryAfterMs, status: res.status }));
      }
      if (res.status === 403) {
        return failAll(new AuthFailed({ status: 403 }));
      }
      if (!(res.status >= 200 && res.status < 300)) {
        return failAll(
          new QueryFailed({ message: `GitHub returned HTTP ${res.status}.` }),
        );
      }

      const parsed = yield* Effect.result(res.json);
      if (Result.isFailure(parsed)) {
        failAll(toPrError(parsed.failure));
        return;
      }
      const body = parsed.success as GraphQLBody | null;
      if (body == null) {
        return failAll(
          new QueryFailed({
            message: "GitHub returned a malformed response body.",
          }),
        );
      }

      if (
        body?.data == null &&
        Array.isArray(body?.errors) &&
        body.errors.length > 0
      ) {
        const first = String(
          body.errors[0]?.message ?? "GitHub returned an error",
        );
        return failAll(
          new QueryFailed({ message: `GitHub returned an error: ${first}` }),
        );
      }

      entries.forEach((entry, i) => {
        const node = body?.data?.[`a${i}`]?.pullRequest;
        if (!node) {
          entry.completeUnsafe(
            Exit.fail(new NotFound({ key: entry.request.ref.key })),
          );
          return;
        }
        entry.completeUnsafe(
          Exit.succeed({
            state: deriveState(String(node.state), Boolean(node.isDraft)),
            title: String(node.title ?? ""),
          }),
        );
      });
    }),
  ).pipe(RequestResolver.batchN(BATCH_MAX));
});
