import axios from 'axios';
import { acquire, resolveRateLimitConfig } from '../translate/utils/rateLimiter';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';
import { throwIfSignalCancelled } from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';

/**
 * 火山翻译网页版免签接口（translate.volcengine.com/crx/translate/v1），
 * 协议对齐 hedaoDict（TechDecryptor pot 插件同款）。无需 API Key，
 * 单条请求单条翻译；语言码用标准短码（zh/en/ja…，源语种可传 auto）。
 */
const VOLCENGINE_FREE_ENDPOINT =
  'https://translate.volcengine.com/crx/translate/v1';

interface VolcengineFreeResponse {
  translation?: string;
}

async function requestOnce(
  text: string,
  from: string,
  to: string,
  options?: TranslationRequestOptions,
): Promise<string> {
  const response = await axios.post(
    VOLCENGINE_FREE_ENDPOINT,
    {
      source_language: from,
      target_language: to,
      text,
    },
    { timeout: TRANSLATION_REQUEST_TIMEOUT, signal: options?.signal },
  );
  const data: VolcengineFreeResponse | undefined = response.data;
  const translation = data?.translation;
  if (typeof translation !== 'string' || !translation.trim()) {
    throw new Error('volcengine free translate failed: 响应缺少 translation');
  }
  return translation;
}

export default async function volcengineFree(
  query: string | string[],
  proof: Record<string, any>,
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  const list = Array.isArray(query) ? query : [query];
  const rateKey = `volcengineFree:${proof?.id || 'volcengineFree'}`;
  const rateCfg = resolveRateLimitConfig(proof);
  const results: string[] = [];

  for (const text of list) {
    if (!text || !text.trim()) {
      results.push(text ?? '');
      continue;
    }
    await acquire(rateKey, rateCfg, options?.signal);
    try {
      results.push(await requestOnce(text, sourceLanguage, targetLanguage, options));
    } catch (error: any) {
      throwIfSignalCancelled(options?.signal);
      throw new Error(
        `Volcengine free translate failed (network): ${
          error?.message || 'request error'
        }`,
      );
    }
  }

  return Array.isArray(query) ? results : results[0];
}
