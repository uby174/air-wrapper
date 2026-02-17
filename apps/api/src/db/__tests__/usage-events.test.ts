import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../client', () => ({
  query: queryMock
}));

describe('writeUsageEvent', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('writes usage row with cost_estimate into usage_events', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'user-123' }]).mockResolvedValueOnce([]);

    const { writeUsageEvent } = await import('../usage-events');

    await writeUsageEvent({
      useCase: 'chat_simple',
      tokensIn: 120.9,
      tokensOut: 42.1,
      costEstimate: 0.004321
    });

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0]?.[0]).toContain('insert into users');
    expect(queryMock.mock.calls[1]?.[0]).toContain('insert into usage_events');
    expect(queryMock.mock.calls[1]?.[1]).toEqual(['user-123', 'chat_simple', 121, 42, 0.004321]);
  });
});
