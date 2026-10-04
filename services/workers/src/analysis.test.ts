import { describe, expect, it } from 'vitest';
import { blockedCategories } from './analysis.ts';

const label = (name: string, parentName: string, level: number) => ({
  name,
  parentName,
  level,
  confidence: 90,
});

describe('blockedCategories', () => {
  it('is empty when nothing was found', () => {
    expect(blockedCategories([])).toEqual([]);
  });

  it('ignores allowed top-level categories', () => {
    expect(
      blockedCategories([label('Alcohol', '', 1), label('Swimwear or Underwear', '', 1)]),
    ).toEqual([]);
  });

  it('blocks on a top-level category returned with its details', () => {
    expect(
      blockedCategories([
        label('Explicit', '', 1),
        label('Explicit Nudity', 'Explicit', 2),
        label('Exposed Female Nipple', 'Explicit Nudity', 3),
      ]),
    ).toEqual(['Explicit']);
  });

  it('blocks a detailed label even if its top-level category is missing', () => {
    expect(blockedCategories([label('Weapons', 'Violence', 2)])).toEqual(['Violence']);
  });

  it('lists each blocked category once, sorted', () => {
    expect(
      blockedCategories([
        label('Violence', '', 1),
        label('Hate Symbols', '', 1),
        label('Weapons', 'Violence', 2),
        label('Alcohol', '', 1),
      ]),
    ).toEqual(['Hate Symbols', 'Violence']);
  });
});
