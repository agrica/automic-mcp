import { expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

it('exposes a semver version', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
