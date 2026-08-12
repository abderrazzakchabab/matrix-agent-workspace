import { describe, it, expect } from 'vitest';
import { RunRequest, RunResponse } from '../src/run';
import { RunEvent } from '../src/events';
import { ApiError } from '../src/errors';

describe('RunRequest', () => {
  it('parses a valid parallel request', () => {
    const result = RunRequest.parse({
      prompt: 'Summarize the open issues',
      mode: 'parallel',
      specialistIds: ['repo-reader', 'issue-reader'],
    });
    expect(result.mode).toBe('parallel');
    expect(result.specialistIds).toEqual(['repo-reader', 'issue-reader']);
  });

  it('parses a valid sequential request', () => {
    const result = RunRequest.parse({
      prompt: 'Review PRs',
      mode: 'sequential',
      specialistIds: ['pr-reader'],
    });
    expect(result.mode).toBe('sequential');
  });

  it('rejects unknown run mode', () => {
    expect(() =>
      RunRequest.parse({
        prompt: 'p',
        mode: 'invalid',
        specialistIds: ['repo-reader'],
      }),
    ).toThrow();
  });

  it('rejects empty specialist configuration', () => {
    expect(() =>
      RunRequest.parse({
        prompt: 'p',
        mode: 'parallel',
        specialistIds: [],
      }),
    ).toThrow();
  });

  it('parses a RunRequest with optional githubContext', () => {
    const result = RunRequest.parse({
      prompt: 'p',
      mode: 'parallel',
      specialistIds: ['repo-reader'],
      githubContext: { repository: 'acme/widget' },
    });
    expect(result.githubContext?.repository).toBe('acme/widget');
  });
});

describe('RunResponse', () => {
  it('parses a valid RunResponse', () => {
    const result = RunResponse.parse({
      runId: 'run_123',
      status: 'queued',
      roomId: '!room:example.test',
      nextSequence: 1,
    });
    expect(result.runId).toBe('run_123');
    expect(result.status).toBe('queued');
    expect(result.nextSequence).toBe(1);
  });
});

describe('RunEvent', () => {
  it('parses a valid run.started event', () => {
    const event = RunEvent.parse({
      id: 'evt_run_123_1',
      runId: 'run_123',
      sequence: 1,
      type: 'run.started',
      version: 1,
      occurredAt: '2026-08-12T12:00:00.000Z',
      visibility: 'room_and_owner',
      payload: {},
    });
    expect(event.type).toBe('run.started');
  });

  it('parses a specialist.completed event with payload', () => {
    const event = RunEvent.parse({
      id: 'evt_run_123_18',
      runId: 'run_123',
      sequence: 18,
      type: 'specialist.completed',
      version: 1,
      occurredAt: '2026-08-12T12:00:01.000Z',
      visibility: 'room_and_owner',
      payload: {
        specialistId: 'issue-reader',
        status: 'completed',
        attempt: 1,
        summary: '3 open issues found',
      },
    });
    expect(event.payload.specialistId).toBe('issue-reader');
  });

  it('rejects an unknown event type', () => {
    expect(() =>
      RunEvent.parse({
        id: 'evt_1',
        runId: 'run_1',
        sequence: 1,
        type: 'unknown.event.type',
        version: 1,
        occurredAt: '2026-08-12T12:00:00.000Z',
        visibility: 'room_and_owner',
        payload: {},
      }),
    ).toThrow();
  });

  it('rejects negative sequence', () => {
    expect(() =>
      RunEvent.parse({
        id: 'evt_1',
        runId: 'run_1',
        sequence: -1,
        type: 'run.started',
        version: 1,
        occurredAt: '2026-08-12T12:00:00.000Z',
        visibility: 'room_and_owner',
        payload: {},
      }),
    ).toThrow();
  });
});

describe('ApiError', () => {
  it('parses a valid error', () => {
    const error = ApiError.parse({
      error: {
        code: 'MATRIX_TOKEN_INVALID',
        message: 'The provided access token is invalid',
        requestId: 'req_123',
      },
    });
    expect(error.error.code).toBe('MATRIX_TOKEN_INVALID');
    expect(error.error.requestId).toBe('req_123');
  });

  it('parses an error with optional details', () => {
    const error = ApiError.parse({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
        requestId: 'req_456',
        details: { field: 'mode', reason: 'unknown mode' },
      },
    });
    expect(error.error.details).toEqual({ field: 'mode', reason: 'unknown mode' });
  });
});
