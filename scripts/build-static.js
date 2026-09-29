#!/usr/bin/env node
/**
 * 构建静态站：扫描 images/ → 生成两档 webp → 输出到 _site/
 *
 * 用法：
 *   npm run build               # 增量构建（源图没变就跳过）
 *   npm run build -- --force    # 强制重新生成所有缩略图
 *
 * 产物结构（_site/ 不进版本库，由 GitHub Actions 在 CI 里生成并部署）：
 *   _site/
 *   ├── photos.json          照片清单：站点信息 + 相册 + 每张照片的尺寸/EXIF/图片路径
 *   ├── index.html           来自 public/
 *   ├── styles.css
 *   ├── app.js
 *   ├── .nojekyll            防止 GitHub Pages 用 Jekyll 处理
 *   └── media/
 *       ├── thumb/<id>.webp  网格卡片用，宽固定 800px（竖幅高度按比例更大）
 *       └── large/<id>.webp  灯箱用，长边上限 2000px
 */

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const sharp = require('sharp');
const exifReaderModule = require('exif-reader');

const readExif = typeof exifReaderModule === 'function' ? exifReaderModule : exifReaderModule.default;

const ROOT = path.join(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'images');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, '_site');
const MEDIA_DIR = path.join(OUT_DIR, 'media');

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff']);

// 站点信息：想改站名/署名，改这里即可
const SITE = {
  title: 'PETER GALLERY',
  author: 'Peter',
  tagline: '光与影的私人收藏',
  description: '个人摄影作品集',
};

/**
 * 首屏背景使用的照片，按「相册名 + 文件名（不含扩展名）」指定。
 * 找不到时会回退到第一张照片，并在构建日志里提示。
 */
const HERO = { album: '东南大学九龙湖', title: 'DSC_0985' };

/**
 * 两档输出尺寸。
 *
 * thumb：网格卡片宽度固定约 350px，所以按「宽度」缩放到 800px——
 *        横竖幅都能拿到约 2.3 倍像素密度，在高清屏上够锐利。
 * large：灯箱容器 .lb-figure 最大 1500px 宽、高度受视口限制，
 *        所以按「长边」缩放到 2000px。若只限宽度，竖幅照片的宽度本就小于 2000，
 *        withoutEnlargement 会直接跳过缩放，长边仍是 2560px，白白浪费体积。
 */
const SIZES = [
  { key: 'thumb', resize: { width: 800, fit: 'inside' }, quality: 78 },
  { key: 'large', resize: { width: 2000, height: 2000, fit: 'inside' }, quality: 84 },
];

const CONCURRENCY = 3;

/* ---------------------------------- 工具 ---------------------------------- */

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 秒 -> 快门速度文案，如 1/250s、2s */
function formatExposure(value) {
  if (!value || !Number.isFinite(value)) return null;
  if (value >= 1) return `${Number(value.toFixed(1))}s`;
  return `1/${Math.round(1 / value)}s`;
}

/**
 * EXIF 分布在两个分组里：机身信息在 Image(IFD0)，曝光参数在 Photo(Exif IFD)。
 * 不同相机/软件写 ISO 的标签名不一致，这里逐个兜底。
 */
function cleanExif(image, photo) {
  if (!image && !photo) return null;
  const img = image || {};
  const ph = photo || {};
  const out = {};

  const model = ph.Model || img.Model;
  if (model) out.camera = String(model).trim();
  if (ph.LensModel) out.lens = String(ph.LensModel).trim();
  if (ph.FocalLength) out.focal = `${Math.round(ph.FocalLength)}mm`;
  if (ph.FNumber) out.aperture = `f/${Number(ph.FNumber.toFixed(1))}`;

  const shutter = formatExposure(ph.ExposureTime);
  if (shutter) out.shutter = shutter;

  const iso = ph.ISOSpeedRatings ?? ph.ISO ?? ph.PhotographicSensitivity ?? ph.RecommendedExposureIndex;
  if (iso) out.iso = `ISO ${Array.isArray(iso) ? iso[0] : iso}`;

  // 拍摄时间。注意：exif-reader 把 EXIF 里的时间字符串（相机的当地时间）按 UTC 解析，
  // 所以必须用 UTC 取值输出，否则会被系统时区再偏移一次（例如 +08:00 会变成 22:46）。
  const shotAt = ph.DateTimeOriginal || ph.DateTimeDigitized;
  if (shotAt instanceof Date && !Number.isNaN(shotAt.getTime())) {
    out.date = shotAt.toISOString().slice(0, 16).replace('T', ' ');
  }

  return Object.keys(out).length ? out : null;
}

async function listImagesIn(dir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && PHOTO_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
}

/** 源图没变过且产物已存在时跳过，让重复构建很快 */
async function isUpToDate(src, dest) {
  try {
    const [s, d] = await Promise.all([fsp.stat(src), fsp.stat(dest)]);
    return d.mtimeMs >= s.mtimeMs && d.size > 0;
  } catch {
    return false;
  }
}

/** 简单的并发池 */
async function runPool(tasks, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (index < tasks.length) {
      const current = tasks[index++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

/* -------------------------------- 扫描相册 -------------------------------- */

async function discoverPhotos() {
  const photos = [];

  const collect = async (dir, albumName) => {
    const files = await listImagesIn(dir);
    for (const file of files) {
      photos.push({ absPath: path.join(dir, file), album: albumName, title: file.replace(/\.[^.]+$/, '') });
    }
  };

  // 根目录散图 → 「未分类」
  const rootFiles = await listImagesIn(IMAGES_DIR);
  if (rootFiles.length) await collect(IMAGES_DIR, '未分类');

  // 一级子文件夹 → 每个一个相册
  let entries = [];
  try {
    entries = await fsp.readdir(IMAGES_DIR, { withFileTypes: true });
  } catch {
    return { photos: [], albums: [] };
  }

  const subDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));

  for (const name of subDirs) {
    await collect(path.join(IMAGES_DIR, name), name);
  }

  // 相册列表按照片数降序，前端筛选栏直接用这个顺序
  const counts = new Map();
  for (const p of photos) counts.set(p.album, (counts.get(p.album) || 0) + 1);
  const albums = [...counts.entries()]
    .map(([name, count]) => ({ id: name, name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  // 「全部」视图按相册分组展示，相册顺序与筛选栏一致（照片多的在前），
  // 相册内按文件名自然排序。这样在「全部」里浏览时一个相册是连着的。
  const albumOrder = new Map(albums.map((a, index) => [a.name, index]));
  photos.sort((a, b) => (
    albumOrder.get(a.album) - albumOrder.get(b.album)
    || a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  ));

  return { photos, albums };
}

/* -------------------------------- 生成产物 -------------------------------- */

async function build() {
  let force = process.argv.includes('--force');
  const started = Date.now();

  if (!fs.existsSync(IMAGES_DIR)) {
    console.error(`错误：找不到图片目录 ${IMAGES_DIR}`);
    process.exit(1);
  }

  const { photos: found, albums } = await discoverPhotos();

  console.log(`\n源目录 : ${IMAGES_DIR}`);
  console.log(`输出到 : ${OUT_DIR}`);
  console.log(`扫描到 : ${found.length} 张照片 / ${albums.length} 个相册\n`);

  await fsp.mkdir(OUT_DIR, { recursive: true });
  for (const size of SIZES) await fsp.mkdir(path.join(MEDIA_DIR, size.key), { recursive: true });

  // 压缩参数变了就必须全量重建，否则下面的增量检查会以为产物还是最新的、全部跳过。
  // 签名存在 .cache/ 而不是 _site/，避免把构建元数据发布到线上。
  const signature = JSON.stringify(SIZES);
  const signatureFile = path.join(ROOT, '.cache', 'build-config.json');
  const previousSignature = await fsp.readFile(signatureFile, 'utf8').catch(() => null);
  if (!force && previousSignature !== null && previousSignature !== signature) {
    console.log('检测到缩略图参数有变化，本次全量重建\n');
    force = true;
  }
  await fsp.mkdir(path.dirname(signatureFile), { recursive: true });
  await fsp.writeFile(signatureFile, signature);

  // 组装任务：每张照片 × 每档尺寸
  const entries = [];
  const stats = { generated: 0, skipped: 0, failed: 0 };
  let totalBytes = 0;
  let processed = 0;

  for (const item of found) {
    let meta;
    try {
      meta = await sharp(item.absPath).metadata();
    } catch (err) {
      console.error(`  失败   ${path.basename(item.absPath)}：无法解析（${err.message}）`);
      stats.failed++;
      continue;
    }
    if (!meta.width || !meta.height) {
      console.error(`  失败   ${path.basename(item.absPath)}：读不到尺寸`);
      stats.failed++;
      continue;
    }

    // EXIF 方向为 5~8 时，展示尺寸需要对调
    const swapped = meta.orientation >= 5 && meta.orientation <= 8;
    let exif = null;
    if (meta.exif) {
      try {
        const parsed = readExif(meta.exif);
        exif = cleanExif(parsed.Image, parsed.Photo);
      } catch {
        exif = null;
      }
    }

    const id = crypto.createHash('md5').update(path.relative(IMAGES_DIR, item.absPath)).digest('hex').slice(0, 12);
    const files = {};
    for (const size of SIZES) files[size.key] = `media/${size.key}/${id}.webp`;

    entries.push({
      id,
      absPath: item.absPath,
      album: item.album,
      title: item.title,
      width: swapped ? meta.height : meta.width,
      height: swapped ? meta.width : meta.height,
      exif,
      files,
    });
  }

  const tasks = [];
  for (const entry of entries) {
    for (const size of SIZES) tasks.push({ entry, size });
  }
  const total = tasks.length;
  console.log(`开始生成 ${total} 个文件...`);

  await runPool(tasks, CONCURRENCY, async ({ entry, size }) => {
    const dest = path.join(OUT_DIR, entry.files[size.key]);

    try {
      if (!force && await isUpToDate(entry.absPath, dest)) {
        stats.skipped++;
      } else {
        await sharp(entry.absPath)
          .rotate() // 按 EXIF 方向摆正，并把方向标记归一为 1
          .resize({ ...size.resize, withoutEnlargement: true })
          .flatten({ background: '#0a0a0b' })
          .webp({ quality: size.quality })
          .toFile(dest);
        stats.generated++;
      }

      // 必须先 await 拿到值再累加。写成 `total += (await ...)` 会因为复合赋值先读左值、
      // 而 await 期间其它并发任务也读同一个旧值并写回，导致统计被覆盖、结果忽大忽小。
      const bytes = (await fsp.stat(dest)).size;
      totalBytes += bytes;
    } catch (err) {
      stats.failed++;
      console.error(`\n  失败   ${entry.title} (${size.key})：${err.message}`);
    }

    processed++;
    if (processed % 20 === 0 || processed === total) {
      process.stdout.write(`\r  进度 ${processed}/${total}`);
    }
  });
  process.stdout.write('\n');

  // 清理已删除照片留下的陈旧产物
  const expected = new Set(entries.flatMap((e) => SIZES.map((s) => path.join(OUT_DIR, e.files[s.key]))));
  let removed = 0;
  for (const size of SIZES) {
    const dir = path.join(MEDIA_DIR, size.key);
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      const full = path.join(dir, name);
      if (!expected.has(full)) {
        await fsp.rm(full, { force: true });
        removed++;
      }
    }
  }

  // 复制页面源码
  for (const name of await fsp.readdir(PUBLIC_DIR)) {
    await fsp.copyFile(path.join(PUBLIC_DIR, name), path.join(OUT_DIR, name));
  }
  // 防止 GitHub Pages 用 Jekyll 处理（服务端产物的兜底保护）
  await fsp.writeFile(path.join(OUT_DIR, '.nojekyll'), '');

  // 首屏背景图：按配置查找，找不到就回退到第一张
  let hero = entries.length ? entries[0].files.large : null;
  let heroLabel = entries.length ? `${entries[0].album}/${entries[0].title}` : '（无照片）';
  if (entries.length && HERO) {
    const matched = entries.find((e) => e.album === HERO.album && e.title === HERO.title)
      || entries.find((e) => e.title === HERO.title);
    if (matched) {
      hero = matched.files.large;
      heroLabel = `${matched.album}/${matched.title}`;
    } else {
      console.warn(`\n  提示：首屏配置的照片 ${HERO.album}/${HERO.title} 不存在，已回退到 ${heroLabel}\n`);
    }
  }

  // 照片清单
  const manifest = {
    site: SITE,
    generatedAt: new Date().toISOString(),
    hero,
    albums,
    photos: entries.map(({ id, album, title, width, height, exif, files }) => ({
      id, album, title, width, height, exif,
      thumb: files.thumb,
      large: files.large,
    })),
  };
  await fsp.writeFile(path.join(OUT_DIR, 'photos.json'), JSON.stringify(manifest));

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log('─'.repeat(52));
  console.log(`照片 ${entries.length} 张 · 相册 ${albums.length} 个`);
  console.log(`首屏背景 ${heroLabel}`);
  console.log(`生成 ${stats.generated} 个文件 · 跳过 ${stats.skipped} 个（未变化）${stats.failed ? ` · 失败 ${stats.failed} 个` : ''}`);
  if (removed) console.log(`清理陈旧产物 ${removed} 个`);
  console.log(`图片体积 ${formatSize(totalBytes)} · 耗时 ${seconds}s`);
  console.log('');
  console.log(`本地预览： npm run preview`);
  console.log('');

  process.exit(stats.failed > 0 ? 1 : 0);
}

build().catch((err) => {
  console.error(`\n构建失败：${err.message}\n`);
  process.exit(1);
});
