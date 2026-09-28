#!/usr/bin/env bash
#
# 把构建好的静态站同步到你自己的服务器（可选方案）
#
# 线上默认由 GitHub Pages 托管，这个脚本用于把同一份 _site/ 产物同步到自己的服务器。
# 服务器上**不需要装 Node**——纯静态文件，Nginx 直接托管即可。
#
# 用法：
#   ./deploy.sh user@服务器IP:/var/www/petergallery
#
# 前置条件：
#   1) 本地能 ssh 到服务器（已配好免密登录）
#   2) 服务器已装 Nginx，站点根目录指向上面那个路径
#   3) 会先自动执行 npm run build
#
# 首次部署时服务器上的准备：
#   sudo mkdir -p /var/www/petergallery && sudo chown "$USER" /var/www/petergallery
#
set -euo pipefail

cd "$(dirname "$0")"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "用法： ./deploy.sh user@服务器IP:/var/www/petergallery" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "错误：未找到 rsync" >&2
  exit 1
fi

echo "==> 构建静态站"
npm run build

if [ ! -f _site/index.html ]; then
  echo "错误：构建产物 _site/index.html 不存在" >&2
  exit 1
fi

echo "==> 同步到 ${TARGET}"
# --delete 会让服务器上已删除的照片一并消失，保持与本地一致。
# 目标目录必须是专门的站点根目录，不要指向包含其他内容的目录。
rsync -avz --delete --human-readable _site/ "$TARGET/"

COUNT="$(find _site/media/thumb -type f | wc -l | tr -d ' ')"
echo ""
echo "==> 部署完成"
echo "    照片 ${COUNT} 张，产物大小 $(du -sh _site | cut -f1)"
echo "    服务器上无需 Node 进程，Nginx 托管静态文件即可。"
echo ""
