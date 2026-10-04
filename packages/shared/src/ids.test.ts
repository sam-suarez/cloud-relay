import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { uuidv7, uuidv7Time } from './ids.ts';

describe('uuidv7', () => {
  it('is a valid version 7 UUID', () => {
    const id = uuidv7();

    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });

  it('starts with the timestamp in milliseconds', () => {
    const now = Date.UTC(2026, 9, 4, 3, 13, 46, 123);

    expect(uuidv7(now).replace('-', '').slice(0, 12)).toBe(now.toString(16).padStart(12, '0'));
  });

  it('sorts IDs from later milliseconds after earlier ones, as plain strings', () => {
    const now = Date.now();
    const ids = [uuidv7(now + 2), uuidv7(now), uuidv7(now + 1)];

    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('is random within the same millisecond', () => {
    expect(uuidv7(0)).not.toBe(uuidv7(0));
  });
});

describe('uuidv7Time', () => {
  it('reads back the creation time', () => {
    const now = Date.UTC(2026, 9, 4, 15, 38, 36, 242);

    expect(uuidv7Time(uuidv7(now))).toBe(now);
  });

  it('returns null for other UUID versions', () => {
    expect(uuidv7Time('6f1c2a5e-8a9b-4c1d-9e2f-3a4b5c6d7e8f')).toBeNull();
    expect(uuidv7Time('not-a-uuid')).toBeNull();
  });
});
