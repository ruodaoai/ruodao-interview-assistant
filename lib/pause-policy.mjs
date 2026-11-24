/**
 * 批量投递「要不要停下来等本人」的判定。
 *
 * 登录 / 人机验证 / 窗口被关 / 任务被中止 → 后面每条都会撞同一堵墙，必须暂停；
 * 单条「没看到成功回执」→ 只这条记为待确认，队列继续投下一个。
 */

const GATE_PATTERNS = [
  /需要登录/,
  /登录态/,
  /需要人机验证/,
  /验证/,
  /窗口已关闭/,
  /已中止/,
  /已停止/,
  /超时/,
  /页面没有加载出来/,
  /页面空白/,
];

const RATE_LIMIT_PATTERNS = [
  /频率限制/,
  /操作(?:过于|太)?频繁/,
  /沟通次数.*上限/,
  /请求太频繁/,
];

export function shouldPauseBatch(input) {
  const reason = String(input.blockedReason ?? "");
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(reason))) return true;
  if (input.state === "blocked") return true;
  if (input.state !== "needs_user") return false;
  return GATE_PATTERNS.some((pattern) => pattern.test(reason));
}

/** 岗位已关闭 / 已下线：跳过这一条，但绝不能计入连续失败熔断。 */
export function isClosedJobReason(reason) {
  return /岗位已关闭|已下线|停止招聘|职位不存在|职位已失效|该职位已过期/.test(String(reason ?? ""));
}
