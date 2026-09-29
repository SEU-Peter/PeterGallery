# Peter Gallery

个人摄影作品集网站，使用纯静态文件构建，并通过 GitHub Pages 发布。

线上地址：[seu-peter.github.io/PeterGallery](https://seu-peter.github.io/PeterGallery/)

## 功能

- 自动扫描 `images/` 下的照片，并按一级文件夹生成相册
- 精选作品、相册入口、瀑布流作品档案与相册筛选
- 灯箱查看、EXIF 拍摄参数、键盘切图和移动端滑动切图
- 构建时生成 WebP 缩略图与灯箱大图，避免发布原始照片

## 本地使用

需要 Node.js 18 或更高版本。

```bash
npm install
npm run build
npm run preview
```

在浏览器打开 `http://localhost:4173` 查看网站。

## 添加照片

把照片放入 `images/`：

```text
images/
├── 中学校园/
│   └── PANA1593.jpg
├── 玄武湖/
│   └── PANA1247.jpg
└── 单张照片.jpg
```

- 一级子文件夹会成为相册名称。
- 直接放在 `images/` 根目录的照片会归入“未分类”。
- 添加或替换照片后运行 `npm run build`。

## 编辑精选作品

在 `scripts/build-static.js` 的 `SITE.featured` 数组中按顺序填写图片相对路径：

```js
featured: [
  '中学校园/PANA1593.jpg',
  '鱼嘴公园/PANA0707.jpg',
],
```

数组顺序就是首页展示顺序；删掉一项即可移除精选。修改后重新运行 `npm run build`。

## 部署

推送到 `main` 分支会由 GitHub Actions 自动构建并部署到 GitHub Pages。

```bash
git add .
git commit -m "更新作品集"
git push origin main
```

构建产物位于 `_site/`，不需要提交到仓库。
