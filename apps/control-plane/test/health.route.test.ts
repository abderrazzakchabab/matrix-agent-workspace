import { describe, it, expect } from 'vitest';
import { GET } from '../src/app/api/health/route';

describe('GET /api/health', () => {
  it('returns status ok with version 1', async () => {
    const response = await GET();
    const json = await response.json();
    expect(json).toEqual({ status: 'ok', version: 1 });
  });
});
