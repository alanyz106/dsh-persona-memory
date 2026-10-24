/**
 * Minimal local `JsonValue` alias.
 *
 * dsh-tools exported `JsonValue` in the 0.1.x line but stopped re-exporting it
 * (it now aliases the type from `@deepseek-ai/dsh-util-values`, which is not a
 * published dependency we may import). Declaring the shape here keeps the host
 * build independent of that internal package while staying structurally
 * identical, so casts to tool return values keep typechecking.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
