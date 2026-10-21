/**
 * Names that must never be used as keys of a plain object built from user input: assigning them changes the
 * object's prototype (or reads an inherited function) instead of storing a value.
 */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export const isUnsafeKey = (key: string): boolean => UNSAFE_KEYS.has(key);

/** True when `obj` has `key` as its own property (never an inherited one such as `toString`). */
export const hasOwnKey = (obj: object, key: string): boolean => Object.hasOwn(obj, key);
