import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';

/**
 * Wraps a sensitive value so it cannot leak through logging, JSON serialization,
 * string interpolation, or `util.inspect`. The raw value is only reachable via
 * an explicit `reveal()` call, which makes every use site greppable.
 */
export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
