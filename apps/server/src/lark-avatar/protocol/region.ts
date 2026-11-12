import type { LarkRegionName } from '../types.js';

export interface LarkRegion {
  name: LarkRegionName;
  label: string;
  domain: string;
  webAppId: string;
  locale: string;
  ticketUrl: string;
  apiHost: string;
  userInfoUrl: string;
  gatewayUrl: string;
  webOrigin: string;
  messengerPageUrl: string;
  qrRedirectUri: string;
  accountsOrigin: string;
  wsUrl: string;
}

const buildRegion = (
  name: LarkRegionName,
  label: string,
  domain: string,
  locale: string
): LarkRegion => {
  const webOrigin = `https://open-dev.${domain}`;
  const apiHost = `https://internal-api-lark-api.${domain}`;
  return {
    name,
    label,
    domain,
    webAppId: '161471',
    locale,
    ticketUrl: `https://login.${domain}/suite/passport/frontier_ticket/`,
    apiHost,
    userInfoUrl: `${apiHost}/accounts/web/user`,
    gatewayUrl: `${apiHost}/im/gateway/`,
    webOrigin,
    messengerPageUrl: `${webOrigin}/messenger/`,
    qrRedirectUri: `${webOrigin}/next/messenger`,
    accountsOrigin: `https://accounts.${domain}`,
    wsUrl: `wss://msg-frontier.${domain}/ws/v2`
  };
};

export const LARK_REGIONS: Record<LarkRegionName, LarkRegion> = {
  feishu: buildRegion('feishu', '飞书', 'feishu.cn', 'zh_CN'),
  lark: buildRegion('lark', 'Lark', 'larksuite.com', 'en_US')
};

export const isLarkRegionName = (value: unknown): value is LarkRegionName =>
  value === 'feishu' || value === 'lark';

export const getRegion = (name: LarkRegionName): LarkRegion => LARK_REGIONS[name];
