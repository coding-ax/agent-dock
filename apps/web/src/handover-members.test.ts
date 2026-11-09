import { describe, expect, it } from 'vitest';
import { defaultHandoverPicked, filterHandoverCandidates, toggleHandoverPicked, type HandoverCandidate } from './handover-members';

const candidates: HandoverCandidate[] = [
  { openId: 'ou_owner', name: '机器人创建者' },
  { openId: 'ou_self', name: '暮雪离歌' },
  { openId: 'ou_other', name: '另一位成员' }
];

describe('handover member selection', () => {
  it('prefers the remembered self, then the app owner, then the first candidate', () => {
    expect(defaultHandoverPicked(candidates, 'ou_owner', 'ou_self')).toEqual(['ou_self']);
    expect(defaultHandoverPicked(candidates, 'ou_owner', '')).toEqual(['ou_owner']);
    expect(defaultHandoverPicked(candidates.slice(1), 'ou_owner', '')).toEqual(['ou_self']);
    expect(defaultHandoverPicked([], 'ou_owner', 'ou_self')).toEqual([]);
  });

  it('can clear the last selected member instead of restoring a default', () => {
    const cleared = toggleHandoverPicked(['ou_self'], 'ou_self');
    expect(cleared).toEqual([]);
    expect(defaultHandoverPicked(candidates, 'ou_owner', '').length).toBe(1);
    expect(toggleHandoverPicked(cleared, 'ou_other')).toEqual(['ou_other']);
  });

  it('keeps selected candidates visible and first when filtering by name', () => {
    expect(filterHandoverCandidates(candidates, '另一位', ['ou_self'])).toEqual([
      candidates[1],
      candidates[2]
    ]);
    expect(filterHandoverCandidates(candidates, '', [])).toEqual(candidates);
    expect(filterHandoverCandidates(candidates, '不存在', [])).toEqual([]);
  });
});
