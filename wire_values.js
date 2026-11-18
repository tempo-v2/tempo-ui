/**
 * Internal value checks shared by reply validation and intent construction.
 * Public behavior is exercised by their scenario tests; this is not a package API.
 */
export function string(value, name, nonempty = false) {
  if (typeof value !== "string" || (nonempty && value.length === 0)) {
    throw new TypeError(
      `${name} must be ${nonempty ? "a nonempty" : "a"} string`,
    );
  }
  return value;
}

export function freeze(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function object(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${name} has missing or unexpected fields`);
  }
}

export function boolean(value, name) {
  if (typeof value !== "boolean")
    throw new TypeError(`${name} must be a boolean`);
  return value;
}

// The calling endpoint validator checks the version of its own reply.
export function validateErrorView(value) {
  object(value, ["schema_version", "status", "code", "message", "retryable"], "error view");
  return freeze({
    schema_version: value.schema_version,
    status: "error",
    code: string(value.code, "code", true),
    message: string(value.message, "message"),
    retryable: boolean(value.retryable, "retryable"),
  });
}
