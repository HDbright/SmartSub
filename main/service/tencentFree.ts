import axios from 'axios';
import {
  acquire,
  resolveRateLimitConfig,
} from '../translate/utils/rateLimiter';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';
import { throwIfSignalCancelled } from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';

/**
 * 腾讯翻译君微信小程序免签接口（wxapp.translator.qq.com/api/translate），
 * 协议对齐 hedaoDict（TechDecryptor pot 插件同款）。无需 API Key；
 * 请求端固定 source/target=auto，语种经 candidateLangs 提示（短码 zh/en/ja…）。
 */
const TENCENT_FREE_ENDPOINT =
  'https://wxapp.translator.qq.com/api/translate';
const TENCENT_FREE_GUID = 'oqdgX0SIwhvM0TmqzTHghWBvfk22';
const TENCENT_FREE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.32(0x18002035) NetType/WIFI Language/zh_TW';
const TENCENT_FREE_REFERER =
  'https://servicewechat.com/wxb1070eabc6f9107e/117/page-frame.html';

interface TencentFreeResponse {
  targetText?: string;
}

async function requestOnce(
  text: string,
  from: string,
  to: string,
  options?: TranslationRequestOptions,
): Promise<string> {
  const response = await axios.get(TENCENT_FREE_ENDPOINT, {
    params: {
      source: 'auto',
      target: 'auto',
      sourceText: text,
      platform: 'WeChat_APP',
      guid: TENCENT_FREE_GUID,
      candidateLangs: `${from}|${to}`,
    },
    headers: {
      'User-Agent': TENCENT_FREE_UA,
      Referer: TENCENT_FREE_REFERER,
    },
    timeout: TRANSLATION_REQUEST_TIMEOUT,
    signal: options?.signal,
  });
  const data: TencentFreeResponse | undefined = response.data;
  const targetText = data?.targetText;
  if (typeof targetText !== 'string' || !targetText.trim()) {
    throw new Error('tencent free translate failed: 响应缺少 targetText');
  }
  return targetText;
}

export default async function tencentFree(
  query: string | string[],
  proof: Record<string, any>,
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  const list = Array.isArray(query) ? query : [query];
  const rateKey = `tencentFree:${proof?.id || 'tencentFree'}`;
  const rateCfg = resolveRateLimitConfig(proof);
  const from = sourceLanguage || 'auto';
  const to = targetLanguage || 'zh';
  const results: string[] = [];

  for (const text of list) {
    if (!text || !text.trim()) {
      results.push(text ?? '');
      continue;
    }
    await acquire(rateKey, rateCfg, options?.signal);
    try {
      results.push(await requestOnce(text, from, to, options));
    } catch (error: any) {
      throwIfSignalCancelled(options?.signal);
      throw new Error(
        `Tencent free translate failed (network): ${
          error?.message || 'request error'
        }`,
      );
    }
  }

  return Array.isArray(query) ? results : results[0];
}
