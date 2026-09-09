import React from 'react';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/**
 * 复读页路由占位：RepeatWorkbench 由 Layout 常驻挂载（跨页面保活，
 * 切页保留播放与编辑状态），本页不再重复渲染工作台。
 */
export default function RepeatPage() {
  return null;
}

export const getStaticProps = makeStaticProperties(['common', 'repeat']);
export { getStaticPaths };
