import { describe, expect, it } from 'vitest';
import { autoCollapseOpen, toggleAutoCollapse } from './auto-collapse-state';

describe('execution process disclosure', () => {
  it('opens while running and closes immediately at completion, even after a manual click', () => {
    expect(autoCollapseOpen(true)).toBe(true);
    const manuallyClosed = toggleAutoCollapse(true);
    expect(autoCollapseOpen(true, manuallyClosed)).toBe(false);
    const manuallyReopened = toggleAutoCollapse(true, manuallyClosed);
    expect(autoCollapseOpen(true, manuallyReopened)).toBe(true);
    expect(autoCollapseOpen(false, manuallyReopened)).toBe(false);
  });

  it('lets the user reopen a completed process without auto closing it again', () => {
    const reopened = toggleAutoCollapse(false, { active: true, open: true });
    expect(autoCollapseOpen(false, reopened)).toBe(true);
    expect(autoCollapseOpen(false, toggleAutoCollapse(false, reopened))).toBe(false);
  });
});
