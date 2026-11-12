export interface SupervisionSystemRoundCopy {
  title: string;
  badge: string;
  description: string;
}

const copy: SupervisionSystemRoundCopy = {
  title: '系统自动开了一轮 · 督办',
  badge: '系统轮次',
  description: 'daemon 在侧边会话完成后自动注入，不是用户消息'
};

/** 网页上的系统轮次标识文案。抽成纯函数，避免组件改动时悄悄改掉用户看到的解释。 */
export function supervisionSystemRoundCopy(): SupervisionSystemRoundCopy {
  return { ...copy };
}
