#!/bin/sh
# 用 pi-jev-governor 扩展启动 pi，并在启动前 source 本地环境变量。
#
# 用法（在任意草稿项目目录下）：
#   <仓库路径>/scripts/run.sh [额外的 pi 参数...]
# 例如全旁路冒烟：
#   <仓库路径>/scripts/run.sh --no-jev
# 模型路由的作用域由 --models（复数）定义，三档全列即可自由切换；想锁定单模型，
# 把它作为 --models 的唯一条目（超出作用域的档位切换会被 scopedModels 守卫跳过；
# --model 单数只设定初始模型，不构成作用域）：
#   <仓库路径>/scripts/run.sh --models qwen/qwen3.7-plus,qwen/qwen3.7-flash,qwen/qwen3.7-max
#
# 密钥只放在仓库根目录的 .env.local（已 gitignore）。

set -ea

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$ROOT/.env.local" ]; then
	echo "error: $ROOT/.env.local 不存在。先执行：" >&2
	echo "  cp $ROOT/.env.local.example $ROOT/.env.local  # 然后填入真实 key" >&2
	exit 1
fi

. "$ROOT/.env.local"

exec pi -e "$ROOT" "$@"
