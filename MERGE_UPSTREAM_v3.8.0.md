# 上游更新合并说明（v3.8.0）

- **合并时间**：2026-09-10
- **上游仓库**：https://github.com/buxuku/SmartSub （remote: `origin`）
- **合并范围**：`bbf4607..origin/main`，共 **9 个上游提交**（v3.7.1 → v3.8.0，91 个文件，+4123 / −458）
- **合并方式**：`git merge origin/main`，仅 `package.json` 出现 1 处冲突，手工解决

## 一、上游带来的更新

| 上游提交  | 内容                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------- |
| `5283e55` | **feat(subtitles)**: 字幕导出支持多种输出格式（新增 `types/subtitleOutput.ts` 及向导/导出链路改造） |
| `898f89a` | **fix(subtitles)**: 多格式导出评审问题修复                                                          |
| `f3b02fc` | **fix(subtitles)**: 窄窗口下向导格式控件换行显示修复                                                |
| `5c505b3` | **feat**: 批量编号功能                                                                              |
| `b609345` | **feat(audio)**: 新增小米 MiMo ASR / TTS 服务商                                                     |
| `18abd69` | **docs**: 小米 MiMo 语音服务商文档                                                                  |
| `3a2c98d` | **fix**: 免费翻译接口更新修复                                                                       |
| `408e177` | **perf(ci)**: CI 产物保留期调整                                                                     |
| `d13e773` | **docs**: 更新 change log                                                                           |

## 二、冲突解决

| 文件           | 冲突                                     | 解决方式           |
| -------------- | ---------------------------------------- | ------------------ |
| `package.json` | 版本号 `3.7.2`（本地）vs `3.8.0`（上游） | 采用上游 **3.8.0** |

`renderer/public/locales/{zh,en}/common.json` 双方均有新增键，git 自动合并成功，已验证 JSON 语法完整。

## 三、本地定制（全部完好保留）

- **复读模块**（上游未触碰任何 `renderer/components/repeat/*` 文件）：
  - 字幕画布拖拽/字号直调、自动换行开关、键盘导航（↑/↓/←/→/Shift+←→）、长按逐帧
  - 分组播放（右键菜单 + 分组按钮）、媒体属性窗口、元信息编辑（EXDEV/CRLF 修复）
  - 文件名显示模式（自定义/文件名/标签标题/专辑名）、`useMediaTagNames` 标签探测
  - `main/helpers/mediaMeta.ts`、SQLite 复读库（`sql.js` 依赖保留）
- **开发脚本**：`dev` 命令保持 `node scripts/dev.mjs`（端口自愈启动器，避开 Windows 保留端口段）
- **字幕合并模块增强**：`autoWrap` 类型/预览 CSS、字号范围 8–72（`subtitleMerge/constants.ts`、`styleUtils.ts` 上游未动）

## 四、合并后验证

| 检查项                               | 结果                    |
| ------------------------------------ | ----------------------- |
| `npm install`（上游依赖变化）        | ✅ 成功                 |
| `npx tsc --noEmit`（非测试代码）     | ✅ 零错误               |
| `npm run build`（渲染进程 + 主进程） | ✅ exit 0               |
| i18n 审计（代码引用 vs zh/en JSON）  | ✅ 无缺失键、无错误插值 |

## 五、后续

- 合并提交已推送至 gitee 镜像（`git push gitee main`）
- 建议实测上游新功能：字幕多格式导出、批量编号、小米 MiMo 服务商、免费翻译接口
- 本地新装环境注意：`npm install` 可能重新拉取损坏的 ffmpeg-static 二进制（如遇问题参照 `node_modules/ffmpeg-static` 替换为完整版 ffmpeg）
