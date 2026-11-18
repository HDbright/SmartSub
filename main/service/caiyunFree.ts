import { randomUUID } from 'crypto';
import axios from 'axios';
import { convertLanguageCode } from '../helpers/utils';
import {
  acquire,
  resolveRateLimitConfig,
} from '../translate/utils/rateLimiter';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';
import { throwIfSignalCancelled } from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';

/**
 * 彩云小译 iOS 客户端免签接口（interpreter.cyapi.cn/v1/translator），
 * 协议对齐 hedaoDict（TechDecryptor pot 插件同款）。无需 API Key；
 * trans_type 用短码 from2to（auto2zh / en2ja…），每请求随机 device_id。
 */
const CAIYUN_FREE_ENDPOINT = 'https://interpreter.cyapi.cn/v1/translator';
const CAIYUN_TOKEN = 'token ssdj273ksdiwi923bsd9';
const CAIYUN_USER_AGENT =
  'caiyunInterpreter/5 CFNetwork/1404.0.5 Darwin/22.3.0';

interface CaiyunFreeResponse {
  target?: string;
}

async function requestOnce(
  text: string,
  from: string,
  to: string,
  options?: TranslationRequestOptions,
): Promise<string> {
  const response = await axios.post(
    CAIYUN_FREE_ENDPOINT,
    {
      source: text,
      detect: true,
      os_type: 'ios',
      device_id: randomUUID(),
      trans_type: `${from}2${to}`,
      media: 'text',
      request_id: Date.now() % 1000000000,
      user_id: '',
      dict: true,
    },
    { timeout: TRANSLATION_REQUEST_TIMEOUT, signal: options?.signal, headers: { 'x-authorization': CAIYUN_TOKEN, 'user-agent': CAIYUN_USER_AGENT } },
  );
  const data: CaiyunFreeResponse | undefined = response.data;
  const target = data?.target;
  if (typeof target !== 'string' || !target.trim()) {
    throw new Error('caiyun free translate failed: 响应缺少 target');
  }
  return target;
}

export default async function caiyunFree(
  query: string | string[],
  proof: Record<string, any>,
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  const list = Array.isArray(query) ? query : [query];
  const rateKey = `caiyunFree:${proof?.id || 'caiyunFree'}`;
  const rateCfg = resolveRateLimitConfig(proof);
  const from = convertLanguageCode(sourceLanguage, 'caiyun') || 'auto';
  const to = convertLanguageCode(targetLanguage, 'caiyun');
  if (!to) {
    throw new Error(
      `Caiyun free translate failed: 不支持的目标语种 ${targetLanguage}`,
    );
  }
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
        `Caiyun free translate failed (network): ${
          error?.message || 'request error'
        }`,
      );
    }
  }

  return Array.isArray(query) ? results : results[0];
}
