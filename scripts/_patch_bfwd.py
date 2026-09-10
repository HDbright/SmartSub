# -*- coding: utf-8 -*-
"""BLE 按键：连发去抖 + bFwd 按下立即执行(长按追加清除AB)，消除误清与跳变"""
import io

p = 'renderer/components/repeat/RepeatWorkbench.tsx'
s = io.open(p, encoding='utf-8').read()

# 1. 连发去抖 ref
old = """  const bleHoldRef = useRef<{
    code: string;
    actionId: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);"""
new = """  const bleHoldRef = useRef<{
    code: string;
    actionId: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  // 同一键码最近一次按下时间（设备连发帧去抖）
  const bleLastPressRef = useRef<Record<string, number>>({});"""
assert s.count(old) == 1
s = s.replace(old, new)

# 2. 事件处理重写：去抖 + bFwd 按下立即执行
old = """        if (payload.type !== 'code' || !payload.value) return;
        const runAction = (actionId: string) =>
          remoteActionsRef.current.find((a) => a.id === actionId)?.run?.();
        if (payload.value === '00') {
          // 松开帧：长按未达阈值 → 执行常规动作；已达阈值（长按已触发）→ 不再执行
          const h = bleHoldRef.current;
          if (h) {
            if (h.timer) clearTimeout(h.timer);
            bleHoldRef.current = null;
            runAction(h.actionId);
          }
          return;
        }
        // 按下帧：上一键仍在长按判定中又被新键按下 → 取消判定并执行原动作
        if (bleHoldRef.current) {
          const h = bleHoldRef.current;
          if (h.timer) clearTimeout(h.timer);
          bleHoldRef.current = null;
          runAction(h.actionId);
        }
        const actionId = bleMapRef.current[payload.value];
        if (!actionId) return;
        // 长按清除 AB：B+ 键按住 1 秒、B 点键按住 2 秒（AB 循环激活时）
        const holdMs =
          actionId === 'bFwd' && abRef.current.b != null
            ? 1000
            : actionId === 'setB' && abRef.current.b != null
              ? 2000
              : 0;
        if (holdMs > 0) {
          bleHoldRef.current = {
            code: payload.value,
            actionId,
            timer: setTimeout(() => {
              bleHoldRef.current = null;
              stopAb();
              toast.success(t('toast.abCleared'));
            }, holdMs),
          };
          return;
        }
        runAction(actionId);
      },"""

new = """        if (payload.type !== 'code' || !payload.value) return;
        const code = payload.value;
        const nowMs = Date.now();
        const runAction = (actionId: string) =>
          remoteActionsRef.current.find((a) => a.id === actionId)?.run?.();
        if (code === '00') {
          // 松开帧：长按未触发过 → 执行常规动作；已触发（如长按清除）→ 不再执行
          const h = bleHoldRef.current;
          if (h) {
            if (h.timer) clearTimeout(h.timer);
            bleHoldRef.current = null;
            runAction(h.actionId);
          }
          return;
        }
        // 设备连发去抖：同一键码 300ms 内的重复按下帧忽略
        if (nowMs - (bleLastPressRef.current[code] || 0) < 300) return;
        bleLastPressRef.current[code] = nowMs;
        // 按下帧：上一键仍在长按判定中又被新键按下 → 取消判定并执行原动作
        if (bleHoldRef.current) {
          const h = bleHoldRef.current;
          if (h.timer) clearTimeout(h.timer);
          bleHoldRef.current = null;
          runAction(h.actionId);
        }
        const actionId = bleMapRef.current[code];
        if (!actionId) return;
        if (actionId === 'bFwd' && abRef.current.b != null) {
          // B+ 按下立即 +0.5s（确定性移动）；按住满 1 秒追加清除 AB
          runAction('bFwd');
          bleHoldRef.current = {
            code,
            actionId,
            timer: setTimeout(() => {
              bleHoldRef.current = null;
              stopAb();
              toast.success(t('toast.abCleared'));
            }, 1000),
          };
          return;
        }
        runAction(actionId);
      },"""
assert s.count(old) == 1, 'handler anchor'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('debounce + immediate bFwd ok')
