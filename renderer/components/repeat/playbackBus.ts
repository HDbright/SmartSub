/**
 * 复读页播放状态广播（页面保活方案）：
 * RepeatWorkbench 常驻挂载（切页不销毁），通过此总线向 Layout 底部状态栏
 * 广播播放进度，并接收迷你播放条的命令（播放/暂停、停止、上下句）。
 */

export interface RepeatPlaybackStatus {
  hasMedia: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
}

export type RepeatPlaybackCommand = 'toggle' | 'stop' | 'prev' | 'next';

type StatusListener = (status: RepeatPlaybackStatus) => void;
type CommandListener = (command: RepeatPlaybackCommand) => void;

const statusListeners = new Set<StatusListener>();
const commandListeners = new Set<CommandListener>();

export const repeatPlaybackBus = {
  emitStatus(status: RepeatPlaybackStatus) {
    statusListeners.forEach((l) => l(status));
  },
  onStatus(listener: StatusListener): () => void {
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  },
  sendCommand(command: RepeatPlaybackCommand) {
    commandListeners.forEach((l) => l(command));
  },
  onCommand(listener: CommandListener): () => void {
    commandListeners.add(listener);
    return () => {
      commandListeners.delete(listener);
    };
  },
};
