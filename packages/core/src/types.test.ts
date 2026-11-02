import { runInNewContext } from 'node:vm';
import { FatalError } from '@workflow/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatErrorCauseChain,
  getErrorMessage,
  isAbortError,
  normalizeUnknownError,
  promoteAbortErrorToFatal,
  toPlainError,
} from './types.js';

describe('getErrorMessage', () => {
  it('reads a native error message across realms without adding its name', () => {
    expect(
      getErrorMessage(runInNewContext('new TypeError("remote error")'))
    ).toBe('remote error');
  });

  it.each([
    null,
    undefined,
    'plain failure',
    42,
  ])('stringifies non-error values (%s)', (value) => {
    expect(getErrorMessage(value)).toBe(String(value));
  });
});

describe('isAbortError', () => {
  it('recognizes an AbortError from another realm', () => {
    const error = runInNewContext(
      'Object.assign(new Error("cancelled"), { name: "AbortError" })'
    );

    expect(error).not.toBeInstanceOf(Error);
    expect(isAbortError(error)).toBe(true);
  });

  it.each([
    { name: 'AbortError', message: 'serialized abort' },
    new DOMException('dom abort', 'AbortError'),
  ])('recognizes abort-shaped values', (error) => {
    expect(isAbortError(error)).toBe(true);
  });

  it.each([
    null,
    undefined,
    { name: 'TypeError', message: 'not an abort' },
    { name: 'AbortError' },
    { name: 'AbortError', message: 42 },
    { name: 'AbortError', message: 'bad stack', stack: 42 },
  ])('rejects non-abort values', (value) => {
    expect(isAbortError(value)).toBe(false);
  });
});

describe('promoteAbortErrorToFatal', () => {
  it('promotes an abort-shaped value to FatalError and preserves its stack', () => {
    const error = {
      name: 'AbortError',
      message: 'cancelled',
      stack: 'AbortError: cancelled',
    };

    const promoted = promoteAbortErrorToFatal(error);

    expect(FatalError.is(promoted)).toBe(true);
    expect(promoted).toMatchObject({
      name: 'FatalError',
      message: 'Aborted: cancelled',
      stack: error.stack,
    });
  });

  it('preserves an already fatal abort error', () => {
    const error = Object.assign(new FatalError('already fatal'), {
      name: 'AbortError',
    });

    expect(promoteAbortErrorToFatal(error)).toBe(error);
  });
});

describe('formatErrorCauseChain', () => {
  it.each([
    'cause',
    'name',
    'message',
    'code',
    'errors',
  ])('tolerates a throwing %s getter in the cause chain', (property) => {
    const cause = new Error('inner');
    Object.defineProperty(cause, property, {
      get() {
        throw new Error('getter failed');
      },
    });

    expect(formatErrorCauseChain(new Error('outer', { cause }))).toContain(
      '[unavailable cause]'
    );
  });

  it('preserves readable links before an inaccessible cause', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const middle = new Error('middle', { cause: proxy });

    expect(formatErrorCauseChain(new Error('outer', { cause: middle }))).toBe(
      'Error: middle\n[unavailable cause]'
    );
  });

  it('tolerates a throwing getter on the outer cause', () => {
    const error = new Error('outer');
    Object.defineProperty(error, 'cause', {
      get() {
        throw new Error('getter failed');
      },
    });

    expect(formatErrorCauseChain(error)).toBe('[unavailable cause]');
  });

  it('returns an empty string when there is no cause', () => {
    expect(formatErrorCauseChain(new Error('boom'))).toBe('');
    expect(formatErrorCauseChain('not an error')).toBe('');
    expect(formatErrorCauseChain(undefined)).toBe('');
  });

  it('renders the wrapped reason a `fetch failed` hides', () => {
    // The whole point: the outer error says nothing, the cause says
    // everything. The outer link is skipped — the log already prints it.
    const cause = Object.assign(new Error('other side closed'), {
      name: 'SocketError',
      code: 'UND_ERR_SOCKET',
    });
    const wrapper = new TypeError('fetch failed', { cause });

    expect(formatErrorCauseChain(wrapper)).toBe(
      'SocketError: other side closed (UND_ERR_SOCKET)'
    );
  });

  it('renders each link of a multi-level chain, outermost first', () => {
    const inner = Object.assign(
      new Error('getaddrinfo ENOTFOUND ai-gateway.vercel.sh'),
      { code: 'ENOTFOUND' }
    );
    const wrapper = new Error('POST /v4/… transport failure (ENOTFOUND)', {
      cause: new TypeError('fetch failed', { cause: inner }),
    });

    expect(formatErrorCauseChain(wrapper)).toBe(
      [
        'TypeError: fetch failed',
        // The code is already in the message, so it is not repeated.
        'Error: getaddrinfo ENOTFOUND ai-gateway.vercel.sh',
      ].join('\n')
    );
  });

  it('summarizes the attempts an AggregateError collects', () => {
    // A happy-eyeballs connect reports every address it tried on `errors`
    // and leaves the AggregateError itself blank.
    const aggregate = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
        Object.assign(new Error('connect ECONNREFUSED [::1]:443'), {
          code: 'ECONNREFUSED',
        }),
      ],
      ''
    );

    expect(
      formatErrorCauseChain(new TypeError('fetch failed', { cause: aggregate }))
    ).toBe(
      [
        'AggregateError',
        'Error: connect ECONNREFUSED 10.0.0.1:443',
        'Error: connect ECONNREFUSED [::1]:443',
      ].join('\n')
    );
  });

  it('caps a long chain', () => {
    let error = new Error('innermost');
    for (let i = 0; i < 8; i++) {
      error = new Error(`level ${i}`, { cause: error });
    }

    const lines = formatErrorCauseChain(error).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toBe('…');
  });

  it('stops on a cyclic chain', () => {
    const inner = new Error('inner') as Error & { cause?: unknown };
    const outer = new Error('outer', { cause: inner });
    inner.cause = outer;

    expect(formatErrorCauseChain(outer)).toBe(
      ['Error: inner', 'Error: outer'].join('\n')
    );
  });

  it('renders a non-error cause', () => {
    expect(
      formatErrorCauseChain(new Error('boom', { cause: 'a string' }))
    ).toBe('a string');
  });
});

describe('normalizeUnknownError', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('describes a rejected promise by its reason', async () => {
    const thrown = Promise.reject(new Error('quota exceeded'));
    await expect(normalizeUnknownError(thrown)).resolves.toMatchObject({
      name: 'Error',
      message: 'Promise rejection: quota exceeded',
    });
  });

  it('describes a promise that resolves to a promise by the final value', async () => {
    const thrown = Promise.resolve(Promise.resolve('late value'));
    await expect(normalizeUnknownError(thrown)).resolves.toMatchObject({
      message: 'Promise rejection: late value',
    });
  });

  it('settles for a thenable that never calls back', async () => {
    vi.useFakeTimers();
    const normalized = normalizeUnknownError({
      // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
      then() {},
    });
    await vi.runAllTimersAsync();
    await expect(normalized).resolves.toMatchObject({
      message: expect.stringMatching(/did not settle/),
    });
  });

  it('waits for a thrown promise that settles after a few seconds', async () => {
    vi.useFakeTimers();
    const thrown = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('slow error body')), 5_000);
    });
    thrown.catch(() => {});
    const normalized = normalizeUnknownError(thrown);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(normalized).resolves.toMatchObject({
      message: 'Promise rejection: slow error body',
    });
  });

  it('reads the settle limit from WORKFLOW_THROWN_THENABLE_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    vi.stubEnv('WORKFLOW_THROWN_THENABLE_TIMEOUT_MS', '30000');
    const thrown = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('very slow error body')), 20_000);
    });
    thrown.catch(() => {});
    const normalized = normalizeUnknownError(thrown);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(normalized).resolves.toMatchObject({
      message: 'Promise rejection: very slow error body',
    });
  });

  it('settles for a thenable that keeps resolving to a thenable', async () => {
    const chain = {
      // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
      then(resolve: (value: unknown) => void) {
        resolve(chain);
      },
    };
    await expect(normalizeUnknownError(chain)).resolves.toMatchObject({
      message: expect.stringMatching(/kept resolving/),
    });
  });

  it('treats a then that throws as a rejection', async () => {
    const thrown = {
      // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
      then() {
        throw new Error('then exploded');
      },
    };
    await expect(normalizeUnknownError(thrown)).resolves.toMatchObject({
      message: 'Promise rejection: then exploded',
    });
  });

  it('describes a value whose then getter throws', async () => {
    const thrown = {
      // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
      get then() {
        throw new Error('getter exploded');
      },
    };
    await expect(normalizeUnknownError(thrown)).resolves.toMatchObject({
      name: 'Error',
    });
  });

  it('describes a value that refuses every conversion', async () => {
    const thrown = {
      toJSON() {
        throw new Error('no json');
      },
      toString() {
        throw new Error('no string');
      },
    };
    await expect(normalizeUnknownError(thrown)).resolves.toMatchObject({
      name: 'Error',
      message: expect.any(String),
    });
  });
});

describe('toPlainError', () => {
  const describeAs = (error: Error) => ({
    name: error.name,
    message: error.message,
    stack: '',
  });

  it('keeps the members of a nested aggregate', () => {
    const inner = new AggregateError(
      [new Error('ipv4 refused'), new Error('ipv6 refused')],
      'connect failed'
    );
    const outer = new AggregateError([inner], 'all upstreams failed');

    const plain = toPlainError(outer, describeAs(outer)) as AggregateError;
    const member = plain.errors[0] as AggregateError;
    expect(member.name).toBe('AggregateError');
    expect(member.errors.map((error: Error) => error.message)).toEqual([
      'ipv4 refused',
      'ipv6 refused',
    ]);
  });

  it('describes a cause that is not an error', () => {
    const error = new Error('upstream returned 503', {
      cause: { status: 503 },
    });
    const primitive = new Error('upstream returned 503', { cause: 'busy' });

    expect(toPlainError(error, describeAs(error)).cause).toMatchObject({
      name: 'Error',
      message: '{"status":503}',
    });
    expect(toPlainError(primitive, describeAs(primitive)).cause).toBe('busy');
  });

  it('skips a cause whose getter throws', () => {
    const error = Object.defineProperty(new Error('outer'), 'cause', {
      get() {
        throw new Error('getter exploded');
      },
    });

    expect(toPlainError(error, describeAs(error)).cause).toBeUndefined();
  });

  it('keeps a cyclic cause chain finite', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;

    const plain = toPlainError(first, describeAs(first));
    const cause = plain.cause as Error;
    expect(cause.message).toBe('second');
    expect((cause.cause as Error).message).toBe('first');
    expect((cause.cause as Error).cause).toBeUndefined();
  });

  it('keeps an aggregate that contains itself finite', () => {
    const aggregate = new AggregateError([], 'all failed');
    aggregate.errors.push(aggregate);

    const plain = toPlainError(
      aggregate,
      describeAs(aggregate)
    ) as AggregateError;
    expect(plain.errors).toHaveLength(1);
    expect(plain.errors[0]).toMatchObject({
      name: 'Error',
      message: 'all failed',
    });
    expect(plain.errors[0].errors).toBeUndefined();
  });
});
