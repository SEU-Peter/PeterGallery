/**
 * 本地静态预览服务器
 *
 * 线上由 GitHub Pages 直接托管构建产物 _site/，不需要任何服务端进程。
 * 这个脚本只在本地用来预览构建结果。
 *
 * 用法：
 *   npm run build     # 先生成 _site/
 *   npm run preview   # 再启动本地预览
 */

'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const SITE_DIR = path.join(__dirname, '_site');
const PORT = Number(process.env.PORT) || 4173;

const indexPath = path.join(SITE_DIR, 'index.html');
if (!fs.existsSync(indexPath)) {
  console.error('\n找不到构建产物 _site/index.html，请先执行：\n\n    npm run build\n');
  process.exit(1);
}

let photoCount = 0;
try {
  photoCount = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'photos.json'), 'utf8')).photos.length;
} catch {
  /* 清单缺失时只是少打一行日志，不影响预览 */
}

const app = express();
app.use(express.static(SITE_DIR));

app.listen(PORT, () => {
  const size = (() => {
    try {
      return `${(fs.statSync(path.join(SITE_DIR, 'photos.json')).size / 1024).toFixed(0)}KB 清单`;
    } catch {
      return '';
    }
  })();

  console.log(`\n  静态预览已启动`);
  console.log(`  访问地址： http://localhost:${PORT}`);
  console.log(`  构建产物： ${SITE_DIR}`);
  console.log(`  照片数量： ${photoCount} 张${size ? `（${size}）` : ''}`);
  console.log('');
  console.log('  这是本地预览，线上由 GitHub Pages 托管同一份 _site/ 产物。');
  console.log('');
});
