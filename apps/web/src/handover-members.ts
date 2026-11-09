export type HandoverCandidate = { openId: string; name: string };

/** 未手动选人时的默认勾选：上次选过的自己 > 机器人创建者 > 第一个可见候选。 */
export function defaultHandoverPicked(
  candidates: HandoverCandidate[],
  ownerOpenId: string | undefined,
  selfOpenId: string
): string[] {
  const visible = (openId: string) => candidates.some(user => user.openId === openId);
  if (selfOpenId && visible(selfOpenId)) return [selfOpenId];
  if (ownerOpenId && visible(ownerOpenId)) return [ownerOpenId];
  return candidates.length ? [candidates[0]!.openId] : [];
}

/** 点击成员胶囊：选中追加，再点取消；最后一个也能清空，不会被默认值悄悄补回来。 */
export function toggleHandoverPicked(picked: string[], openId: string): string[] {
  return picked.includes(openId) ? picked.filter(id => id !== openId) : [...picked, openId];
}

/** 搜索时不隐藏已选成员，并把已选项排到前面，避免「选了却看不见」。 */
export function filterHandoverCandidates(
  candidates: HandoverCandidate[],
  keyword: string,
  picked: string[]
): HandoverCandidate[] {
  const query = keyword.trim().toLowerCase();
  const selected = new Set(picked);
  return candidates
    .filter(user => selected.has(user.openId) || !query || user.name.toLowerCase().includes(query))
    .sort((left, right) => Number(selected.has(right.openId)) - Number(selected.has(left.openId)));
}
