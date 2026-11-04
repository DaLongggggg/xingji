#!/bin/zsh

set -u
unsetopt BG_NICE
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

PROJECT_DIR="${0:A:h:h}"
PORT="3111"
INTERNAL_PORT="$((PORT + 73))"
LOCAL_URL="http://127.0.0.1:${PORT}"
SERVICE_PID=""
WAITER_PID=""
START_LOG=""

pause_before_exit() {
  if [[ -t 0 ]]; then
    echo
    read -r "?按回车键关闭窗口..."
  fi
}

fail() {
  echo "启动失败：$1"
  pause_before_exit
  exit 1
}

open_page() {
  if [[ "${XINGJI_OPEN_BROWSER:-1}" != "0" ]]; then
    open "${LOCAL_URL}/?startup=$(date +%s)"
  fi
}

listener_pid() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
}

show_addresses() {
  echo "本机访问：${LOCAL_URL}"
  local lan_ip
  lan_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [[ -z "${lan_ip}" ]]; then
    lan_ip="$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" { print $2; exit }')"
  fi
  if [[ -n "${lan_ip}" ]]; then
    echo "手机访问：http://${lan_ip}:${PORT}（同一 WiFi）"
  fi
}

cd "${PROJECT_DIR}" || fail "找不到项目目录。"
[[ -f scripts/start-beta.mjs ]] || fail "缺少项目启动器。"
[[ -f .local/mobile-beta/beta-manifest.json ]] || fail "现有内测资料目录未初始化；请核对目录，不要重建已有资料。"
NODE_BIN="$(command -v node 2>/dev/null || true)"
[[ -n "${NODE_BIN}" ]] || fail "未找到 Node.js，请安装项目要求的 Node.js 24 或更新版本。"

EXISTING_PID="$(listener_pid "${PORT}")"
if [[ -n "${EXISTING_PID}" ]]; then
  EXISTING_DIR="$(lsof -a -p "${EXISTING_PID}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  EXISTING_COMMAND="$(ps -p "${EXISTING_PID}" -o command= 2>/dev/null || true)"
  if [[ "${EXISTING_DIR}" == "${PROJECT_DIR}" && "${EXISTING_COMMAND}" == *scripts/start-beta.mjs* ]]; then
    # 只复用这份脚本启动的开发模式；旧生产代理即使HTTP200也可能无法初始化。
    # 环境仅在本机筛选标记，绝不打印其中的凭据或其他值。
    if ! ps eww -p "${EXISTING_PID}" -o command= 2>/dev/null | awk '
      { for (i=1; i<=NF; i++) {
        if ($i == "XINGJI_BETA_DEV=1") dev=1;
        if ($i == "XINGJI_NEXT_DIST_DIR=.next/web-3111") dist=1;
      }} END { exit !(dev && dist) }'; then
      fail "3111仍由旧启动方式占用。请在原启动终端按 Ctrl+C 后重新双击；本脚本不会擅自关闭它。"
    fi
    HTTP_STATUS="$(curl --noproxy '*' --connect-timeout 2 --max-time 10 -sS -o /dev/null -w '%{http_code}' "${LOCAL_URL}/api/health" 2>/dev/null || true)"
    if [[ "${HTTP_STATUS}" == "200" || "${HTTP_STATUS}" == "503" ]]; then
      echo "行迹已在运行，打开现有页面。"
      show_addresses
      echo "启动配置若有变更，需在原启动终端按 Ctrl+C 后重新打开。"
      open_page
      exit 0
    fi
    fail "本项目的 ${PORT} 服务尚未响应，请查看原启动终端；本脚本不会关闭它。"
  fi
  fail "端口 ${PORT} 已由其他服务占用（进程 ${EXISTING_PID}），请先核对；本脚本不会自动换端口。"
fi

EXISTING_INTERNAL_PID="$(listener_pid "${INTERNAL_PORT}")"
[[ -z "${EXISTING_INTERNAL_PID}" ]] || fail "内部端口 ${INTERNAL_PORT} 被进程 ${EXISTING_INTERNAL_PID} 占用，请先核对。"

"${NODE_BIN}" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || fail "Node.js 版本过低，需要24或更新版本。"
[[ -x node_modules/.bin/next ]] || fail "尚未安装项目依赖，请先在项目目录运行 pnpm install。"

export XINGJI_BETA_ROOT="${PROJECT_DIR}/.local/mobile-beta"
export XINGJI_BETA_PORT="${PORT}"
export XINGJI_BIND="0.0.0.0"
export XINGJI_BETA_DEV="1"
export XINGJI_NEXT_DIST_DIR=".next/web-3111"

cleanup() {
  [[ -z "${WAITER_PID}" ]] || kill "${WAITER_PID}" >/dev/null 2>&1 || true
  if [[ -n "${SERVICE_PID}" ]] && kill -0 "${SERVICE_PID}" >/dev/null 2>&1; then
    kill -TERM "${SERVICE_PID}" >/dev/null 2>&1 || true
    wait "${SERVICE_PID}" 2>/dev/null || true
  fi
  [[ -z "${START_LOG}" ]] || rm -f "${START_LOG}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

START_LOG="$(mktemp "${TMPDIR:-/tmp}/xingji-web-start.XXXXXX")" || fail "无法创建启动日志。"
echo "正在启动行迹最新 Web 界面..."
echo "项目目录：${PROJECT_DIR}"
show_addresses
echo "保持本窗口开启；停止时按 Ctrl+C。首次编译可能需要稍等。"
echo

# 直接运行现有代理，便于信号准确送达本次子进程；不额外包一层pnpm进程。
"${NODE_BIN}" scripts/start-beta.mjs > >(tee "${START_LOG}") 2>&1 &
SERVICE_PID=$!

open_when_ready() {
  local attempt
  for attempt in {1..180}; do
    kill -0 "${SERVICE_PID}" >/dev/null 2>&1 || return 0
    if grep -Fq "BETA_READY port=${PORT} " "${START_LOG}"; then
      open_page
      return 0
    fi
    sleep 1
  done
  echo "自动打开等待超时。若稍后看到 BETA_READY，可手动访问 ${LOCAL_URL}；请查看上方输出。"
}
open_when_ready &
WAITER_PID=$!

wait "${SERVICE_PID}"
EXIT_CODE=$?
echo
echo "行迹服务已停止。"
pause_before_exit
exit "${EXIT_CODE}"
