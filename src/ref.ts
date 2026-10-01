import { Data, Effect, Schema, SchemaTransformation } from "effect";

/** A pull request reference. Two refs to the same PR are `Equal`. */
export class PrRef extends Data.Class<{
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}> {
  /** The canonical `owner/repo#number`, also the cache key. */
  get key(): string {
    return `${this.owner}/${this.repo}#${this.number}`;
  }

  get url(): string {
    return `https://github.com/${this.owner}/${this.repo}/pull/${this.number}`;
  }
}

const Name = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);

// Digits-only before converting: NumberFromString alone accepts "1e3" and "0x10".
const PrNumber = Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
  Schema.decodeTo(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    SchemaTransformation.numberFromString,
  ),
);

/** Decodes ` owner/repo#number ` into `[owner, "/", repo, "#", number]`. */
const Slug = Schema.Trim.pipe(
  Schema.decodeTo(
    Schema.TemplateLiteralParser([Name, "/", Name, "#", PrNumber]),
  ),
);

export const parseRef = (raw: string) =>
  Schema.decodeUnknownEffect(Slug)(raw).pipe(
    Effect.map(
      ([owner, , repo, , number]) => new PrRef({ owner, repo, number }),
    ),
  );
