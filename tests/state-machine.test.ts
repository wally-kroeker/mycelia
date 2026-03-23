import { describe, it, expect } from 'vitest';
import {
  canTransition,
  afterClaimCreated,
  afterResponseSubmitted,
  afterRatingSubmitted,
  afterClose,
  afterCancel,
  afterExpiry,
  afterAllClaimsExpired,
  claimAfterResponse,
  claimAfterExpiry,
  claimAfterAbandon,
  InvalidTransitionError,
} from '../src/models/state-machine';

describe('canTransition', () => {
  // Valid transitions
  it('allows open → claimed', () => expect(canTransition('open', 'claimed')).toBe(true));
  it('allows open → cancelled', () => expect(canTransition('open', 'cancelled')).toBe(true));
  it('allows open → expired', () => expect(canTransition('open', 'expired')).toBe(true));
  it('allows claimed → open', () => expect(canTransition('claimed', 'open')).toBe(true));
  it('allows claimed → responded', () => expect(canTransition('claimed', 'responded')).toBe(true));
  it('allows claimed → cancelled', () => expect(canTransition('claimed', 'cancelled')).toBe(true));
  it('allows responded → responded (self)', () => expect(canTransition('responded', 'responded')).toBe(true));
  it('allows responded → rated', () => expect(canTransition('responded', 'rated')).toBe(true));
  it('allows rated → rated (self)', () => expect(canTransition('rated', 'rated')).toBe(true));
  it('allows rated → closed', () => expect(canTransition('rated', 'closed')).toBe(true));

  // Invalid transitions
  it('rejects open → responded', () => expect(canTransition('open', 'responded')).toBe(false));
  it('rejects open → rated', () => expect(canTransition('open', 'rated')).toBe(false));
  it('rejects open → closed', () => expect(canTransition('open', 'closed')).toBe(false));
  it('rejects closed → open', () => expect(canTransition('closed', 'open')).toBe(false));
  it('rejects expired → open', () => expect(canTransition('expired', 'open')).toBe(false));
  it('rejects cancelled → open', () => expect(canTransition('cancelled', 'open')).toBe(false));
  it('rejects responded → open', () => expect(canTransition('responded', 'open')).toBe(false));
  it('rejects rated → open', () => expect(canTransition('rated', 'open')).toBe(false));
  it('rejects claimed → expired', () => expect(canTransition('claimed', 'expired')).toBe(false));
  it('rejects responded → closed', () => expect(canTransition('responded', 'closed')).toBe(false));
});

describe('afterClaimCreated', () => {
  it('open → claimed', () => expect(afterClaimCreated('open')).toBe('claimed'));
  it('claimed → claimed (already claimed)', () => expect(afterClaimCreated('claimed')).toBe('claimed'));
  it('responded → responded (keeps state)', () => expect(afterClaimCreated('responded')).toBe('responded'));
  it('rated → rated (keeps state)', () => expect(afterClaimCreated('rated')).toBe('rated'));
  it('throws for closed', () => expect(() => afterClaimCreated('closed')).toThrow(InvalidTransitionError));
  it('throws for expired', () => expect(() => afterClaimCreated('expired')).toThrow(InvalidTransitionError));
  it('throws for cancelled', () => expect(() => afterClaimCreated('cancelled')).toThrow(InvalidTransitionError));
  it('error message contains from and to', () => {
    expect(() => afterClaimCreated('closed')).toThrow('closed');
  });
});

describe('afterResponseSubmitted', () => {
  it('claimed → responded', () => expect(afterResponseSubmitted('claimed')).toBe('responded'));
  it('responded → responded (additional)', () => expect(afterResponseSubmitted('responded')).toBe('responded'));
  it('throws for open', () => expect(() => afterResponseSubmitted('open')).toThrow(InvalidTransitionError));
  it('rated → rated (keeps state)', () => expect(afterResponseSubmitted('rated')).toBe('rated'));
  it('throws for closed', () => expect(() => afterResponseSubmitted('closed')).toThrow(InvalidTransitionError));
  it('throws for expired', () => expect(() => afterResponseSubmitted('expired')).toThrow(InvalidTransitionError));
  it('throws for cancelled', () => expect(() => afterResponseSubmitted('cancelled')).toThrow(InvalidTransitionError));
});

describe('afterRatingSubmitted', () => {
  it('responded → rated', () => expect(afterRatingSubmitted('responded')).toBe('rated'));
  it('rated → rated (additional)', () => expect(afterRatingSubmitted('rated')).toBe('rated'));
  it('throws for open', () => expect(() => afterRatingSubmitted('open')).toThrow(InvalidTransitionError));
  it('throws for claimed', () => expect(() => afterRatingSubmitted('claimed')).toThrow(InvalidTransitionError));
  it('throws for closed', () => expect(() => afterRatingSubmitted('closed')).toThrow(InvalidTransitionError));
  it('throws for expired', () => expect(() => afterRatingSubmitted('expired')).toThrow(InvalidTransitionError));
  it('throws for cancelled', () => expect(() => afterRatingSubmitted('cancelled')).toThrow(InvalidTransitionError));
});

describe('afterClose', () => {
  it('rated → closed', () => expect(afterClose('rated')).toBe('closed'));
  it('throws for open', () => expect(() => afterClose('open')).toThrow(InvalidTransitionError));
  it('throws for claimed', () => expect(() => afterClose('claimed')).toThrow(InvalidTransitionError));
  it('throws for responded', () => expect(() => afterClose('responded')).toThrow(InvalidTransitionError));
  it('throws for expired', () => expect(() => afterClose('expired')).toThrow(InvalidTransitionError));
  it('throws for cancelled', () => expect(() => afterClose('cancelled')).toThrow(InvalidTransitionError));
});

describe('afterCancel', () => {
  it('open with 0 responses → cancelled', () => expect(afterCancel('open', 0)).toBe('cancelled'));
  it('claimed with 0 responses → cancelled', () => expect(afterCancel('claimed', 0)).toBe('cancelled'));
  it('throws for open with responses', () => expect(() => afterCancel('open', 1)).toThrow(InvalidTransitionError));
  it('throws for claimed with responses', () => expect(() => afterCancel('claimed', 1)).toThrow(InvalidTransitionError));
  it('throws for responded', () => expect(() => afterCancel('responded', 0)).toThrow(InvalidTransitionError));
  it('throws for rated', () => expect(() => afterCancel('rated', 0)).toThrow(InvalidTransitionError));
  it('throws for closed', () => expect(() => afterCancel('closed', 0)).toThrow(InvalidTransitionError));
  it('throws for expired', () => expect(() => afterCancel('expired', 0)).toThrow(InvalidTransitionError));
  it('throws for cancelled', () => expect(() => afterCancel('cancelled', 0)).toThrow(InvalidTransitionError));
});

describe('afterExpiry', () => {
  it('open → expired', () => expect(afterExpiry('open')).toBe('expired'));
  it('throws for claimed', () => expect(() => afterExpiry('claimed')).toThrow(InvalidTransitionError));
  it('throws for responded', () => expect(() => afterExpiry('responded')).toThrow(InvalidTransitionError));
  it('throws for rated', () => expect(() => afterExpiry('rated')).toThrow(InvalidTransitionError));
  it('throws for closed', () => expect(() => afterExpiry('closed')).toThrow(InvalidTransitionError));
  it('throws for cancelled', () => expect(() => afterExpiry('cancelled')).toThrow(InvalidTransitionError));
});

describe('afterAllClaimsExpired', () => {
  it('claimed with 0 active and 0 responses → open', () => {
    expect(afterAllClaimsExpired('claimed', 0, 0)).toBe('open');
  });
  it('throws if still has active claims', () => {
    expect(() => afterAllClaimsExpired('claimed', 1, 0)).toThrow(InvalidTransitionError);
  });
  it('throws if has responses', () => {
    expect(() => afterAllClaimsExpired('claimed', 0, 1)).toThrow(InvalidTransitionError);
  });
  it('throws if has both active claims and responses', () => {
    expect(() => afterAllClaimsExpired('claimed', 2, 3)).toThrow(InvalidTransitionError);
  });
  it('throws for non-claimed status', () => {
    expect(() => afterAllClaimsExpired('open', 0, 0)).toThrow(InvalidTransitionError);
  });
  it('throws for responded status', () => {
    expect(() => afterAllClaimsExpired('responded', 0, 0)).toThrow(InvalidTransitionError);
  });
});

describe('claim status transitions', () => {
  it('claimAfterResponse returns completed', () => expect(claimAfterResponse()).toBe('completed'));
  it('claimAfterExpiry returns expired', () => expect(claimAfterExpiry()).toBe('expired'));
  it('claimAfterAbandon returns abandoned', () => expect(claimAfterAbandon()).toBe('abandoned'));
});

describe('InvalidTransitionError', () => {
  it('has correct name', () => {
    const err = new InvalidTransitionError('open', 'closed', 'reason');
    expect(err.name).toBe('InvalidTransitionError');
  });
  it('has from, to, reason properties', () => {
    const err = new InvalidTransitionError('open', 'closed', 'test reason');
    expect(err.from).toBe('open');
    expect(err.to).toBe('closed');
    expect(err.reason).toBe('test reason');
  });
  it('message includes from and to', () => {
    const err = new InvalidTransitionError('open', 'closed', 'test');
    expect(err.message).toContain('open');
    expect(err.message).toContain('closed');
  });
  it('is an instance of Error', () => {
    expect(new InvalidTransitionError('a', 'b', 'c')).toBeInstanceOf(Error);
  });
});
