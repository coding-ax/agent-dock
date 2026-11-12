import type {
  LarkAvatarAccount,
  LarkAvatarCredentials,
  LarkAvatarLoginSnapshot,
  LarkRegionName
} from '../types.js';
import { getRegion, type LarkRegion } from './region.js';

type Fetch = typeof globalThis.fetch;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15_000;

export class LarkAuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'LarkAuthError';
  }
}

const timeoutSignal = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);

const setCookies = (headers: Headers): string[] => {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = extended.getSetCookie?.() ?? [];
  if (values.length) return values;
  const single = headers.get('set-cookie');
  return single ? [single] : [];
};

export class CookieJar {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      if (name && value) this.values.set(name, value);
    }
  }

  absorb(headers: Headers): void {
    for (const raw of setCookies(headers)) {
      const pair = raw.split(';', 1)[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name) this.values.set(name, value);
    }
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
  }

  get(name: string): string {
    return this.values.get(name) ?? '';
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  toObject(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

const fetchWithJar = async (
  fetcher: Fetch,
  input: string,
  init: RequestInit,
  jar: CookieJar,
  maxRedirects = 6
): Promise<Response> => {
  let url = input;
  for (let hop = 0; ; hop += 1) {
    const headers = {
      ...(init.headers as Record<string, string> | undefined),
      cookie: jar.header()
    };
    const response = await fetcher(url, { ...init, headers, redirect: 'manual' });
    jar.absorb(response.headers);
    const location = response.headers.get('location');
    if (!location) return response;
    if (hop >= maxRedirects) {
      await response.body?.cancel().catch(() => undefined);
      throw new LarkAuthError('LARK_REDIRECT_LOOP', `飞书登录页跳转次数过多：${url}`);
    }
    await response.body?.cancel().catch(() => undefined);
    url = new URL(location, url).toString();
  }
};

const qrHeaders = (region: LarkRegion): Record<string, string> => ({
  'user-agent': USER_AGENT,
  'content-type': 'application/json',
  'x-app-id': '1',
  'x-api-version': '1.0.8',
  'x-device-info': 'platform=websdk',
  'x-terminal-type': '2',
  origin: region.accountsOrigin,
  referer: `${region.accountsOrigin}/accounts/page/login?app_id=1`
});

const jsonObject = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    throw new LarkAuthError('LARK_BAD_RESPONSE', `飞书返回了非 JSON 响应（HTTP ${response.status}）`);
  }
};

const readString = (value: unknown): string => typeof value === 'string' ? value : '';

const userFromPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const data = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {};
  const user = data.user && typeof data.user === 'object' ? data.user as Record<string, unknown> : data;
  return user;
};

const accountFromUser = (user: Record<string, unknown>, fallbackId: string): LarkAvatarAccount => {
  const avatar = user.avatar && typeof user.avatar === 'object' ? user.avatar as Record<string, unknown> : {};
  const userId = String(user.id ?? user.user_id ?? user.userId ?? fallbackId);
  const name = readString(user.name)
    || readString(user.cn_name)
    || readString(user.en_name)
    || readString(user.display_name)
    || userId;
  const avatarUrl = readString(user.avatar_url)
    || readString(user.avatarUrl)
    || readString(user.avatar_thumb)
    || readString(avatar.url)
    || readString(avatar.avatar_72)
    || readString(avatar.avatar_240);
  const email = readString(user.email) || readString(user.enterprise_email) || readString(user.enterpriseEmail);
  return {
    userId,
    name,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(email ? { email } : {})
  };
};

export class QrLoginSession {
  readonly region: LarkRegion;
  readonly qrContent: string;
  readonly startedAt: number;
  private readonly fetcher: Fetch;
  private readonly jar: CookieJar;
  private readonly flowKey: string;
  private cancelled = false;
  private lastStatus = -1;
  private activeController?: AbortController;

  private constructor(input: {
    region: LarkRegion;
    fetcher: Fetch;
    jar: CookieJar;
    flowKey: string;
    token: string;
  }) {
    this.region = input.region;
    this.fetcher = input.fetcher;
    this.jar = input.jar;
    this.flowKey = input.flowKey;
    this.qrContent = JSON.stringify({ qrlogin: { token: input.token } });
    this.startedAt = Date.now();
  }

  static async create(input: { region: LarkRegionName; fetcher?: Fetch }): Promise<QrLoginSession> {
    const region = getRegion(input.region);
    const fetcher = input.fetcher ?? fetch;
    const jar = new CookieJar();
    const response = await fetcher(`${region.accountsOrigin}/accounts/qrlogin/init`, {
      method: 'POST',
      headers: qrHeaders(region),
      body: JSON.stringify({ redirect_uri: region.qrRedirectUri }),
      signal: timeoutSignal()
    });
    jar.absorb(response.headers);
    const payload = await jsonObject(response);
    const data = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {};
    const stepInfo = data.step_info && typeof data.step_info === 'object'
      ? data.step_info as Record<string, unknown>
      : {};
    const token = readString(stepInfo.token);
    if (!response.ok || Number(payload.code) !== 0 || !token) {
      throw new LarkAuthError(
        'LARK_QR_INIT_FAILED',
        `获取登录二维码失败：${readString(payload.message) || readString(payload.msg) || `HTTP ${response.status}`}`
      );
    }
    return new QrLoginSession({
      region,
      fetcher,
      jar,
      flowKey: response.headers.get('x-flow-key') ?? '',
      token
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.activeController?.abort();
  }

  cookies(): Record<string, string> {
    return this.jar.toObject();
  }

  async poll(): Promise<{
    state: LarkAvatarLoginSnapshot['state'];
    message: string;
    status?: number;
    step?: string;
  }> {
    if (this.cancelled) return { state: 'failed', message: '登录已取消' };
    const controller = new AbortController();
    this.activeController = controller;
    let response: Response;
    try {
      response = await this.fetcher(`${this.region.accountsOrigin}/accounts/qrlogin/polling`, {
        method: 'POST',
        headers: {
          ...qrHeaders(this.region),
          ...(this.flowKey ? { 'x-flow-key': this.flowKey } : {})
        },
        body: '{}',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)])
      });
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
    this.jar.absorb(response.headers);
    const payload = await jsonObject(response);
    const data = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {};
    const stepInfo = data.step_info && typeof data.step_info === 'object'
      ? data.step_info as Record<string, unknown>
      : {};
    const status = Number(stepInfo.status ?? -1);
    const step = readString(data.next_step);
    const changed = status !== this.lastStatus;
    this.lastStatus = status;

    if (this.jar.has('session') || status === 0) {
      return { state: 'success', message: '登录成功，正在读取账号信息…', status, step };
    }
    if (status === 2) {
      return { state: 'scanned', message: '已扫码，请在手机上确认登录', status, step };
    }
    if (status === 3 || status === 4) {
      return { state: 'failed', message: '扫码已取消或登录出错，请重新生成二维码', status, step };
    }
    if (status === 5) {
      return { state: 'expired', message: '二维码已过期，正在刷新', status, step };
    }
    if (step && step !== 'qr_login_polling' && changed) {
      return { state: 'failed', message: '登录流程未拿到会话，请重试', status, step };
    }
    return {
      state: 'waiting',
      message: `请用${this.region.label} App 扫码`,
      status,
      step
    };
  }

  async finish(): Promise<{ credentials: LarkAvatarCredentials; account: LarkAvatarAccount }> {
    const cookies = this.cookies();
    if (!cookies.session) {
      throw new LarkAuthError('LARK_SESSION_MISSING', '登录流程结束，但没有拿到 session cookie');
    }
    return validateCredentials({
      region: this.region.name,
      cookies,
      fetcher: this.fetcher
    });
  }
}

export const validateCredentials = async (input: {
  region: LarkRegionName;
  cookies: Record<string, string>;
  fetcher?: Fetch;
  savedAt?: number;
}): Promise<{ credentials: LarkAvatarCredentials; account: LarkAvatarAccount }> => {
  const region = getRegion(input.region);
  const fetcher = input.fetcher ?? fetch;
  const jar = new CookieJar(input.cookies);
  if (!jar.has('session')) {
    throw new LarkAuthError('LARK_SESSION_MISSING', 'Cookie 中缺少 session，请确认复制完整');
  }
  const deviceId = jar.get('passport_web_did');
  const ticketResponse = await fetchWithJar(
    fetcher,
    `${region.ticketUrl}?local_device_id=${encodeURIComponent(deviceId)}`,
    {
      headers: {
        'user-agent': USER_AGENT
      },
      signal: timeoutSignal()
    },
    jar
  );
  const ticketPayload = await jsonObject(ticketResponse);
  if (!readString(ticketPayload.ticket)) {
    throw new LarkAuthError(
      'LARK_TICKET_FAILED',
      `会话已被服务端注销或凭证无效：${readString(ticketPayload.message) || readString(ticketPayload.msg) || `HTTP ${ticketResponse.status}`}`
    );
  }

  let user: Record<string, unknown> = {};
  try {
    const userResponse = await fetchWithJar(
      fetcher,
      `${region.userInfoUrl}?app_id=12&_t=${Date.now()}`,
      {
        headers: {
          'user-agent': USER_AGENT,
          'x-app-id': '12',
          'x-api-version': '1.0.8',
          'x-csrf-token': jar.get('swp_csrf_token'),
          'x-device-info': 'platform=websdk',
          'x-lgw-os-type': '1',
          'x-lgw-terminal-type': '2',
          origin: region.webOrigin,
          referer: `${region.webOrigin}/`
        },
        signal: timeoutSignal()
      },
      jar
    );
    user = userFromPayload(await jsonObject(userResponse));
  } catch (error) {
    throw new LarkAuthError(
      'LARK_USER_INFO_FAILED',
      `读取飞书账号资料失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const account = accountFromUser(user, '');
  if (!account.userId) {
    throw new LarkAuthError('LARK_USER_ID_MISSING', '无法读取当前账号 user_id，登录未完成');
  }

  let appKey = '';
  let webAppId = region.webAppId;
  try {
    const pageResponse = await fetchWithJar(
      fetcher,
      region.messengerPageUrl,
      {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml'
        },
        signal: timeoutSignal()
      },
      jar
    );
    const html = await pageResponse.text();
    appKey = /appKey\s*:\s*["']([^"']+)["']/.exec(html)?.[1] ?? '';
    webAppId = /teaAppId["']?\s*:\s*["']?(\d+)/.exec(html)?.[1] ?? webAppId;
  } catch (error) {
    throw new LarkAuthError(
      'LARK_APP_KEY_FAILED',
      `读取飞书网页端连接参数失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!appKey) {
    throw new LarkAuthError('LARK_APP_KEY_MISSING', '登录成功，但网页端 appKey 读取失败，请稍后重试或改用 Cookie 导入');
  }

  try {
    await fetchWithJar(
      fetcher,
      `${region.apiHost}/accounts/csrf?_t=${Date.now()}`,
      {
        method: 'POST',
        headers: {
          'user-agent': USER_AGENT,
          'x-app-id': '12',
          'x-api-version': '1.0.8',
          'x-device-info': 'platform=websdk',
          'x-lgw-os-type': '1',
          'x-lgw-terminal-type': '2',
          origin: region.webOrigin,
          referer: `${region.webOrigin}/`
        }
      },
      jar
    );
  } catch {
    // csrf 只影响网页 API，不影响 WebSocket 和网关发送，失败不阻断登录。
  }

  return {
    credentials: {
      region: region.name,
      cookies: jar.toObject(),
      savedAt: input.savedAt ?? Date.now(),
      deviceId: jar.get('passport_web_did') || deviceId,
      appKey,
      userId: account.userId,
      csrfToken: jar.get('swp_csrf_token'),
      webAppId
    },
    account
  };
};

export const importCookieString = async (input: {
  cookie: string;
  region: LarkRegionName;
  fetcher?: Fetch;
}): Promise<{ credentials: LarkAvatarCredentials; account: LarkAvatarAccount }> => {
  const cookies: Record<string, string> = {};
  for (const part of input.cookie.trim().split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  if (!cookies.session) {
    throw new LarkAuthError('LARK_SESSION_MISSING', 'Cookie 中缺少 session，请确认复制完整');
  }
  return validateCredentials({ region: input.region, cookies, fetcher: input.fetcher });
};
