import { createHash, randomBytes } from 'crypto';
import axios from 'axios';
import { convertLanguageCode } from '../helpers/utils';
import {
  acquire,
  resolveRateLimitConfig,
} from '../translate/utils/rateLimiter';
import { throwIfSignalCancelled } from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';

/**
 * 有道 AI 翻译（LLM）：luna-ai.youdao.com translate_llm 通道。
 * 协议移植自 hedaoDict translate_youdao_llm.rs（逆向有道词典 PC 客户端 11.3.26，意译档）：
 * 1) GET /translate_llm/secret（keyid=ai-translate-llm-pre；签名密钥硬编码于客户端）
 *    → {secretKey, token}，缓存 30 分钟
 * 2) POST /translate_llm/trans（multipart；genSign=非空字段名字典序 k=v &...& key=<secretKey> 取 md5）
 *    → SSE data:{"translation":"<增量>"} 逐帧拼接
 * 配额：按 imei 每天约 3 次，{"code":601} → 轮换随机设备 imei 重取 secret 重试
 * （新设备 = 新配额；合道君 11-10 拍板：仅个人学习研究用，不公开发版）。
 */
const LUNA = 'https://luna-ai.youdao.com';
const SECRET_GETTER_KEY = 'EZAmCfVOH2CrBGMtPrtIPUzyv3bheLdk';
const KEYID_SECRET = 'ai-translate-llm-pre';
const KEYID_TRANS = 'ai-translate-llm';
const CLIENT = 'deskdict';
const PRODUCT = 'deskdict';
const APP_VERSION = '11.3.26.0';
const UA = 'Youdao Desktop Dict (Windows NT 10.0; WOW64)';
const SECRET_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT = 60_000;

interface SecretEntry {
  key: string;
  token: string;
  fetchedAt: number;
}

let cachedSecret: SecretEntry | undefined;
let cachedImei: string | undefined;

const md5 = (v: string) => createHash('md5').update(v, 'utf8').digest('hex');
const nowMs = () => Date.now().toString();

function newImei(): string {
  return randomBytes(16).toString('hex');
}

/** 会话内稳定的随机设备标识（32 位 hex）；额度尽时轮换即新设备。 */
function imei(): string {
  if (!cachedImei) cachedImei = newImei();
  return cachedImei;
}

function rotateImei(): void {
  cachedImei = newImei();
}

/** 通用设备参数（secret 与 trans 两次请求共用；服务端要求参数齐全但不全部参与签名） */
function commonParams(id: string): [string, string][] {
  return [
    ['client', CLIENT],
    ['product', PRODUCT],
    ['appVersion', APP_VERSION],
    ['vendor', 'pc'],
    ['mid', 'pc'],
    ['screen', '1920*1080'],
    ['model', '1'],
    ['imei', id],
    ['network', 'wired'],
    ['keyfrom', 'deskdict.Main'],
    ['yduuid', id],
    ['abtest', '0'],
  ];
}

async function secretFetch(id: string): Promise<SecretEntry> {
  const t = nowMs();
  const sign = md5(
    `client=${CLIENT}&mysticTime=${t}&product=${PRODUCT}&key=${SECRET_GETTER_KEY}`,
  );
  const { data: body } = await axios.get(`${LUNA}/translate_llm/secret`, {
    params: Object.fromEntries([
      ...commonParams(id),
      ['keyid', KEYID_SECRET],
      ['mysticTime', t],
      ['pointParam', 'client,mysticTime,product'],
      ['sign', sign],
    ]),
    timeout: 15_000,
    headers: { 'User-Agent': UA },
  });
  if (body?.code !== 0) {
    throw new Error(`有道 LLM secret 获取失败: ${body?.msg || '?'}`);
  }
  const key = body?.data?.secretKey;
  const token = body?.data?.token || '';
  if (typeof key !== 'string' || !key) {
    throw new Error('有道 LLM secret 响应缺 secretKey');
  }
  return { key, token, fetchedAt: Date.now() };
}

async function ensureSession(): Promise<SecretEntry> {
  if (cachedSecret && Date.now() - cachedSecret.fetchedAt < SECRET_TTL_MS) {
    return cachedSecret;
  }
  cachedSecret = await secretFetch(imei());
  return cachedSecret;
}

/** 有道 v2 签名：非空字段名字典序 k=v 用 & 连接，末尾 key=<secret>；返回 (sign, pointParam) */
function genSign(params: [string, string][], secret: string) {
  const keys = params
    .filter(([, v]) => v !== '')
    .map(([k]) => k)
    .sort();
  keys.push('key');
  const full = new Map<string, string>([...params, ['key', secret]]);
  const s = keys.map((k) => `${k}=${full.get(k)}`).join('&');
  return { sign: md5(s), pointParam: keys.join(',') };
}

async function transOnce(
  s: SecretEntry,
  text: string,
  from: string,
  to: string,
  id: string,
  options?: TranslationRequestOptions,
): Promise<string> {
  const t = nowMs();
  const params: [string, string][] = [
    ...commonParams(id),
    ['keyid', KEYID_TRANS],
    ['mysticTime', t],
    ['token', s.token],
    ['i', text],
    ['from', from],
    ['to', to],
    ['modelName', 'llmLite'],
  ];
  const { sign, pointParam } = genSign(params, s.key);
  params.push(['sign', sign], ['pointParam', pointParam]);
  // multipart 手工构造（空值字段跳过，与客户端 FormData 一致）
  const boundary = `----hd${nowMs()}${process.pid}`;
  let body = '';
  for (const [k, v] of params) {
    if (v === '') continue;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  const res = await axios.post(`${LUNA}/translate_llm/trans`, body, {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'User-Agent': UA,
    },
    timeout: REQUEST_TIMEOUT,
    signal: options?.signal,
    responseType: 'text',
  });
  if (res.status !== 200) {
    throw new Error(`有道 LLM HTTP ${res.status}`);
  }
  // SSE 解析：data:{...} 帧，translation 增量拼接；error 帧带 code
  const raw = typeof res.data === 'string' ? res.data : String(res.data ?? '');
  let out = '';
  let errMsg = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    let j: any;
    try {
      j = JSON.parse(trimmed.slice(5));
    } catch {
      continue;
    }
    if (typeof j.translation === 'string') out += j.translation;
    if (j.code === 601) {
      errMsg = '今日 AI 翻译额度已用完（每设备约 3 次/天）';
    } else if (typeof j.msg === 'string' && j.msg && !out) {
      errMsg = `有道 LLM: ${j.msg}`;
    }
  }
  if (errMsg) throw new Error(errMsg);
  if (!out) throw new Error('有道 LLM 空响应');
  return out;
}

/** 单条翻译：额度耗尽（601）轮换 imei 重试（最多 2 轮）；签名/secret 失效重取一次再试。 */
async function translateWithRetry(
  text: string,
  from: string,
  to: string,
  options?: TranslationRequestOptions,
): Promise<string> {
  const attempt = async (): Promise<string> => {
    const s = await ensureSession();
    return transOnce(s, text, from, to, imei(), options);
  };
  let lastError = '';
  try {
    return await attempt();
  } catch (error: any) {
    lastError = String(error?.message || error);
    throwIfSignalCancelled(options?.signal);
  }
  if (lastError.includes('额度')) {
    for (let i = 0; i < 2; i++) {
      rotateImei();
      cachedSecret = undefined;
      try {
        return await attempt();
      } catch (error: any) {
        lastError = String(error?.message || error);
        throwIfSignalCancelled(options?.signal);
        if (!lastError.includes('额度')) break;
      }
    }
    throw new Error(`有道 LLM 连续多设备额度均不可用: ${lastError}`);
  }
  if (/签名|secret|HTTP 4/.test(lastError)) {
    cachedSecret = undefined;
    return attempt();
  }
  throw new Error(lastError);
}

export default async function youdaoLlmFree(
  query: string | string[],
  proof: Record<string, any>,
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  const list = Array.isArray(query) ? query : [query];
  const rateKey = `youdaoLlmFree:${proof?.id || 'youdaoLlmFree'}`;
  const rateCfg = resolveRateLimitConfig(proof);
  const from = convertLanguageCode(sourceLanguage, 'youdao') || 'auto';
  const to = convertLanguageCode(targetLanguage, 'youdao');
  const results: string[] = [];

  for (const text of list) {
    if (!text || !text.trim()) {
      results.push(text ?? '');
      continue;
    }
    await acquire(rateKey, rateCfg, options?.signal);
    try {
      results.push(await translateWithRetry(text, from, to, options));
    } catch (error: any) {
      throwIfSignalCancelled(options?.signal);
      throw new Error(
        `Youdao LLM free translate failed: ${error?.message || 'request error'}`,
      );
    }
  }

  return Array.isArray(query) ? results : results[0];
}
