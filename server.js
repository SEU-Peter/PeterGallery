/**
 * PeterGallery 服务端
 *
 * 职责：
 *  1. 运行时扫描 images/ 文件夹（根目录照片 + 一级子文件夹作为相册）
 *  2. 读取每张照片的尺寸与 EXIF 信息，并缓存到 .cache/meta.json，避免重复解析
 *  3. 按需生成缩略图（webp，磁盘缓存），减轻前端加载压力
 *  4. 对外提供 /api/photos 数据接口，并托管 public/ 静态页面
 *
 * 新增照片：把文件丢进 images/ 即可，无需改代码、无需重启（扫描结果有短暂缓存）。
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const exifReaderModule = require('exif-reader');

const readExif = typeof exifReaderModule === 'function' ? exifReaderModule : exifReaderModule.default;

const ROOT = __dirname;
const IMAGES_DIR = path.join(ROOT, 'images');
const CACHE_DIR = path.join(ROOT, '.cache');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const META_FILE = path.join(CACHE_DIR, 'meta.json');
const PORT = Number(process.env.PORT) || 4173;

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff']);

// 站点信息：想改站名/署名，改这里即可
const SITE = {
  title: 'PETER GALLERY',
  author: 'Peter',
  tagline: '光与影的私人收藏',
  description: '个人摄影作品集',
};

/* ---------------------------------- 工具 ---------------------------------- */

/** 把 absolute 路径限制在 images/ 之内，防止 ../ 越界读取任意文件 */
function resolveInsideImages(relative) {
  const target = path.resolve(IMAGES_DIR, relative || '');
  const base = path.resolve(IMAGES_DIR);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
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

  return Object.keys(out).length ? out : null;
}

/* ------------------------------- 元数据缓存 ------------------------------- */

let metaCache = {};
let metaDirty = false;

async function loadMetaCache() {
  try {
    metaCache = JSON.parse(await fsp.readFile(META_FILE, 'utf8'));
  } catch {
    metaCache = {};
  }
}

async function persistMetaCache() {
  if (!metaDirty) return;
  metaDirty = false;
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${META_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(metaCache));
  await fsp.rename(tmp, META_FILE);
}

/** 读取单张照片的尺寸 + EXIF，命中缓存则直接返回 */
async function readPhotoMeta(absPath, signature) {
  const cached = metaCache[signature];
  if (cached) return cached;

  try {
    const meta = await sharp(absPath).metadata();
    if (!meta.width || !meta.height) return null;

    // EXIF 方向为 5~8 时，宽高在展示时需要对调
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

    const result = {
      width: swapped ? meta.height : meta.width,
      height: swapped ? meta.width : meta.height,
      exif,
    };
    metaCache[signature] = result;
    metaDirty = true;
    return result;
  } catch (err) {
    console.warn(`[跳过] 无法解析 ${absPath}: ${err.message}`);
    return null;
  }
}

/* --------------------------------- 扫描 --------------------------------- */

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

async function scanLibrary() {
  await fsp.mkdir(IMAGES_DIR, { recursive: true });

  const albums = []; // { id, name, photos: [] }
  const rootPhotos = await listImagesIn(IMAGES_DIR);
  if (rootPhotos.length) {
    albums.push({ id: '__root__', name: '未分类', photos: rootPhotos, dir: IMAGES_DIR });
  }

  const entries = await fsp.readdir(IMAGES_DIR, { withFileTypes: true });
  const subDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));

  for (const name of subDirs) {
    const photos = await listImagesIn(path.join(IMAGES_DIR, name));
    if (photos.length) {
      albums.push({ id: name, name, photos, dir: path.join(IMAGES_DIR, name) });
    }
  }

  const result = [];
  for (const album of albums) {
    for (const file of album.photos) {
      const absPath = path.join(album.dir, file);
      let stat;
      try {
        stat = await fsp.stat(absPath);
      } catch {
        continue;
      }
      const rel = toPosix(path.relative(IMAGES_DIR, absPath));
      const signature = `${rel}|${stat.size}|${Math.round(stat.mtimeMs)}`;
      const meta = await readPhotoMeta(absPath, signature);
      if (!meta) continue;

      result.push({
        id: crypto.createHash('md5').update(rel).digest('hex').slice(0, 12),
        rel,
        album: album.name,
        title: file.replace(/\.[^.]+$/, ''),
        width: meta.width,
        height: meta.height,
        exif: meta.exif,
      });
    }
  }

  await persistMetaCache();

  return {
    site: SITE,
    albums: albums.map((a) => ({ id: a.id, name: a.name, count: a.photos.length })),
    photos: result,
  };
}

// 扫描有成本，做 3 秒短缓存，兼顾「丢进文件夹立刻生效」与性能
let scanCache = { at: 0, data: null };
async function getLibrary() {
  if (scanCache.data && Date.now() - scanCache.at < 3000) return scanCache.data;
  const data = await scanLibrary();
  scanCache = { at: Date.now(), data };
  return data;
}

/* --------------------------------- 服务 --------------------------------- */

const app = express();
// 页面与脚本走 ETag 校验（改完刷新即生效）；图片由 /api/image 做长缓存
app.use(express.static(path.join(ROOT, 'public')));
app.use('/images', express.static(IMAGES_DIR, { maxAge: '7d', index: false }));

app.get('/api/photos', async (req, res) => {
  try {
    res.json(await getLibrary());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '扫描图片目录失败' });
  }
});

/**
 * 缩略图 / 大图：/api/image?p=<相对路径>&w=<宽度>&fit=inside|cover
 * fit 默认 inside（等比缩放到宽度内，不裁切）。
 * 只有显式传 fit=cover 才会裁成正方形——用于首屏那种铺满全屏的背景图。
 * 结果以 webp 落到 .cache/thumbs，重复访问直接命中磁盘缓存
 */
app.get('/api/image', async (req, res) => {
  const rel = String(req.query.p || '');
  const width = Math.min(Math.max(Number(req.query.w) || 1200, 64), 4096);
  const fit = req.query.fit === 'cover' ? 'cover' : 'inside';

  const absPath = resolveInsideImages(rel);
  if (!absPath || !PHOTO_EXT.has(path.extname(absPath).toLowerCase())) {
    return res.status(400).send('非法的图片路径');
  }

  let stat;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    return res.status(404).send('图片不存在');
  }

  const key = crypto
    .createHash('md5')
    .update(`${rel}|${width}|${fit}|${stat.size}|${Math.round(stat.mtimeMs)}`)
    .digest('hex');
  const cachePath = path.join(THUMB_DIR, `${key}.webp`);

  try {
    const cached = await fsp.readFile(cachePath);
    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(cached);
  } catch {
    /* 未命中缓存，继续生成 */
  }

  try {
    const buffer = await sharp(absPath)
      .rotate() // 按 EXIF 方向自动摆正
      .resize({ width, height: fit === 'cover' ? width : undefined, fit, withoutEnlargement: true })
      .webp({ quality: fit === 'cover' ? 78 : 84 })
      .toBuffer();

    await fsp.mkdir(THUMB_DIR, { recursive: true });
    await fsp.writeFile(cachePath, buffer);

    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buffer);
  } catch (err) {
    console.error(`[缩略图失败] ${rel}: ${err.message}`);
    res.status(500).send('生成缩略图失败');
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
  await loadMetaCache();
  const { photos, albums } = await getLibrary();
  console.log(`\n  ${SITE.title} 已启动`);
  console.log(`  本地访问： http://localhost:${PORT}`);
  console.log(`  图片目录： ${IMAGES_DIR}`);
  console.log(`  已加载： ${photos.length} 张照片 / ${albums.length} 个相册\n`);
});
