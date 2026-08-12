/**
 * Public storage boundary for the rest of the extension. Persistence details stay internal so
 * callers depend only on baseline operations and comparison semantics.
 */
export { matchesDisk } from "./baselineEntry";
export type { BaselineEntry } from "./baselineEntry";
export { BaselineStore } from "./baselineStore";
export type { BaselineRead, BaselineStoreOptions } from "./baselineStore";
