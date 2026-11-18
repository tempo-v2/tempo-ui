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
