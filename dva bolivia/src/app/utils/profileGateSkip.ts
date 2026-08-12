import { PROFILE_GATE_SKIP_AUTO_ONCE_SESSION_KEY } from "../constants";

/** 进入 /home/settings 前写入：返回个人中心时跳过「资料未完善」自动弹层一次。 */
export function armProfileGateSkipAutoOnce(): void {
  try {
    sessionStorage.setItem(PROFILE_GATE_SKIP_AUTO_ONCE_SESSION_KEY, "1");
  } catch {
    /* ignore */
  }
}

/**
 * 若已 arm，则本次不自动打开资料层，并延迟清除 sessionStorage。
 * 使用双 rAF：避免 React Strict Mode 下「首遍 effect 同步 remove → 二次挂载读不到 flag」
 * 导致资料层闪一下再被其它状态关掉。
 */
export function consumeProfileGateSkipAutoOnce(): boolean {
  try {
    if (sessionStorage.getItem(PROFILE_GATE_SKIP_AUTO_ONCE_SESSION_KEY) !== "1") {
      return false;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          sessionStorage.removeItem(PROFILE_GATE_SKIP_AUTO_ONCE_SESSION_KEY);
        } catch {
          /* ignore */
        }
      });
    });
    return true;
  } catch {
    return false;
  }
}
