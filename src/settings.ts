import { Context, Effect, Schema } from "effect";
import { DEFAULT_TTL_MS } from "./cache";

/** Falls back to `fallback` when the key is missing or its value does not decode. */
const withDefault =
  <S extends Schema.Top>(fallback: S["Type"] & S["Encoded"]) =>
  (self: S) =>
    self.pipe(
      Schema.catchDecoding(() => Effect.succeedSome(fallback)),
      Schema.withDecodingDefaultKey(Effect.succeed(fallback)),
    );

export const SettingsSchema = Schema.Struct({
  token: Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString)),
  // Logseq can hand a number setting back as a string.
  ttlMinutes: Schema.Union([Schema.Finite, Schema.NumberFromString])
    .check(Schema.isGreaterThan(0))
    .pipe(withDefault(DEFAULT_TTL_MS / 60_000)),
});
/** The settings one instance of `Badges` runs with. A change starts a new instance
 *  rather than updating this one. */
export class Settings extends Context.Service<
  Settings,
  typeof SettingsSchema.Type
>()("logseq-pr-badges/Settings") {}

/** `None` until a token is set: without one, nothing can be fetched. */
export const decodeSettings = Schema.decodeUnknownOption(SettingsSchema);
