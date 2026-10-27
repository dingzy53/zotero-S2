import { Semaphore } from "../s2/rateLimiter";

/**
 * Serializes find-or-create in the library. Agents often call tools in
 * parallel, and two calls that both miss would both create a collection or
 * item. Not reentrant: never take it while already holding it, and keep
 * slow work (PDF downloads) outside it.
 */
export const libraryWrites = new Semaphore(1);
