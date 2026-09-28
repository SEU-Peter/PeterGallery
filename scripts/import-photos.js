#!/usr/bin/env node
/**
 * 批量导入照片：把源目录里的照片压缩后放进 images/
 *
 * 用法：
 *   node scripts/import-photos.js <源目录> [选项]
 *   npm run import -- <源目录>
 *
 * 选项：
 *   --max <像素>         长边上限，默认 2560
 *   --quality <1-100>    JPEG 质量，默认 85
 *   --subsample <档位>   色度抽样 4:2:0 / 4:2:2 / 4:4:4，默认 4:2:0
 *   --clean-name         清理文件名里的导出噪后缀，作为网站显示标题
 *   --force              忽略时间戳，强制重新压缩
 *   --dry-run            只预览会做什么，不写任何文件
 *   --help               查看帮助
 *
 * 目录映射规则：
 *   源目录的下级文件夹  → images/<文件夹名>/     一个文件夹 = 一个相册
 *   源目录根部的散图    → images/<源目录名>/
 *
 * 特性：
 *   - 保留 EXIF（机身/镜头/光圈/快门/ISO），网站灯箱会用到
 *   - 按 EXIF 方向自动摆正，不会出现横竖颠倒
 *   - iPhone 的 HEIC 借助 macOS 自带 sips 转换（sharp 不解码 HEIC）
 *   - 已导入且源文件没变过的照片自动跳过，可反复执行
 *   - 永不删除文件，只新增或覆盖同名输出
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const sharp = require('sharp');

const PROJECT_ROOT = path.join(__dirname, '..');
const TARGET_ROOT = path.join(PROJECT_ROOT, 'images');

// sharp 能直接解码的格式
const SHARP_EXT = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp', '.avif', '.tif', '.tiff', '.gif']);
// 需要 sips 兜底的格式
const HEIC_EXT = new Set(['.heic', '.heif']);
// 完全不支持，仅用于给出明确提示
const RAW_EXT = new Set(['.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.rw2', '.orf', '.pef', '.srw', '.3fr']);

/** 落地页的深色背景，PNG 透明区域会合成到它上面 */
const FLATTEN_BG = '#0a0a0b';

// 允许的 JPEG 色度抽样档位
const SUBSAMPLING = new Set(['4:2:0', '4:2:2', '4:4:4']);

/* --------------------------------- 参数 --------------------------------- */

function parseArgs(argv) {
  const opts = {
    max: 2560, quality: 85, subsample: '4:2:0',
    force: false, dryRun: false, cleanName: false, help: false, source: null,
  };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max') opts.max = Number(argv[++i]);
    else if (arg === '--quality') opts.quality = Number(argv[++i]);
    else if (arg === '--subsample') opts.subsample = argv[++i];
    else if (arg === '--force') opts.force = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--clean-name') opts.cleanName = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else rest.push(arg);
  }

  opts.source = rest[0] || null;
  return opts;
}

const HELP = `
批量导入照片到 images/ 目录

用法:
  node scripts/import-photos.js <源目录> [选项]
  npm run import -- <源目录>

选项:
  --max <像素>         长边上限，默认 2560
  --quality <1-100>    JPEG 质量，默认 85
  --subsample <档位>   色度抽样，可选 4:2:0 / 4:2:2 / 4:4:4，默认 4:2:0。
                       4:4:4 不做色度降采样，能保住高对比边缘的色彩锐度，体积约多 10%
  --clean-name         清理文件名里的导出噪后缀（-已增强 / -降噪 / 结尾序号）作为网站标题，
                       例如 PANA0070-已增强-降噪-2 → PANA0070。不改动源文件
  --force              忽略时间戳，强制重新压缩
  --dry-run            只预览，不写文件
  --help               显示本帮助

常用档位（按需照抄）:
  4K 留档级   --max 4096 --quality 92 --subsample 4:4:4
  视觉无损    --max 99999 --quality 95 --subsample 4:4:4   （不缩小分辨率）
  网页标准    --max 2560 --quality 85                      （默认，体积最小）

示例:
  # 源目录下每个子文件夹各成为一个相册
  npm run import -- ~/照片导出

  # 4K 留档级压缩，先预览再执行
  npm run import -- ~/照片导出 --max 4096 --quality 92 --subsample 4:4:4 --dry-run
`;

/* -------------------------------- 工具函数 -------------------------------- */

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 编辑软件导出时常见的噪音后缀（Adobe/ACR 的「已增强」「降噪」等） */
const NAME_NOISE = ['-已增强', '-降噪', '-增强', '-编辑', '-副本', '-拷贝', '_已增强', '_降噪'];

/**
 * 清理文件名噪音，仅用于生成网站上显示的标题，不改动源文件。
 * 只保留 1~2 位的结尾序号剥离，避免误伤「IMG-2024」这种名字里本来就带数字的情况。
 */
function cleanName(base) {
  let out = base;

  // 结尾的副本序号（如 -2）会挡住后缀匹配，所以先判断是否含噪音标记再剥序号
  if (NAME_NOISE.some((token) => out.includes(token))) {
    out = out.replace(/[-_]\d{1,2}$/, '');
  }

  for (let guard = 0; guard < 10; guard++) {
    const before = out;
    for (const token of NAME_NOISE) {
      if (out.endsWith(token)) out = out.slice(0, -token.length);
    }
    if (out === before) break;
  }

  const trimmed = out.replace(/[-_\s]+$/, '').trim();
  return trimmed || base;
}

function isPhotoFile(name) {
  const ext = path.extname(name).toLowerCase();
  return SHARP_EXT.has(ext) || HEIC_EXT.has(ext) || RAW_EXT.has(ext);
}

/** 列出目录下所有照片文件（含当前不支持的格式，便于提示） */
async function listPhotos(dir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && isPhotoFile(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
}

/** 源目录的下级文件夹作为相册，根目录散图归到以源目录命名的相册 */
async function discoverAlbums(source) {
  const entries = await fsp.readdir(source, { withFileTypes: true });
  const albums = [];

  const subDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));

  for (const name of subDirs) {
    const dir = path.join(source, name);
    const files = await listPhotos(dir);
    if (files.length) albums.push({ name, dir, files });
  }

  const loose = await listPhotos(source);
  if (loose.length) albums.push({ name: path.basename(path.resolve(source)), dir: source, files: loose });

  return albums;
}

/** 输出比源文件新则跳过，保证脚本可反复执行 */
async function isUpToDate(srcPath, destPath) {
  try {
    const [src, dest] = await Promise.all([fsp.stat(srcPath), fsp.stat(destPath)]);
    return dest.mtimeMs >= src.mtimeMs && dest.size > 0;
  } catch {
    return false;
  }
}

/* -------------------------------- 转换实现 -------------------------------- */

/**
 * 用 sips 把 HEIC 转成高质量 JPEG 中转文件。
 * 注意这里不能加 -Z：sips 的 -Z 会把小于上限的图也放大，反而变糊变大。
 */
function sipsToJpeg(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', 'best', srcPath, '--out', destPath],
      (err, stdout, stderr) => {
        if (!err) return resolve();
        if (err.code === 'ENOENT') return reject(new Error('找不到 sips 命令，无法转换 HEIC'));
        reject(new Error((stderr || err.message).trim()));
      },
    );
  });
}

/**
 * 统一用 sharp 落地：按 EXIF 方向摆正 → 缩到长边上限 → 透明区合成深色底 → mozjpeg 编码。
 * .withMetadata() 把 EXIF 写回输出，sharp 会把方向标记归一为 1，不会二次旋转。
 */
async function encodeWithSharp(srcPath, destPath, opts) {
  await sharp(srcPath)
    .rotate()
    .resize({ width: opts.max, height: opts.max, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: FLATTEN_BG })
    .jpeg({ quality: opts.quality, chromaSubsampling: opts.subsample, progressive: true, mozjpeg: true })
    .withMetadata()
    .toFile(destPath);
}

async function compressOne(srcPath, destPath, ext, opts) {
  if (RAW_EXT.has(ext)) {
    throw new Error('RAW 格式不支持，请先在相机软件里导出为 JPEG');
  }

  if (HEIC_EXT.has(ext)) {
    if (process.platform !== 'darwin') {
      throw new Error('HEIC 转换依赖 macOS 自带的 sips，当前系统不支持');
    }
    // sharp 不解码 HEIC，先用 sips 转成中转 JPEG 再交给 sharp。
    // 实测：直接用 sips 输出 JPEG 会比 sharp 编码大约 4 倍；转 TIFF 则会丢 EXIF。
    const tmp = path.join(os.tmpdir(), `pg-import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    try {
      await sipsToJpeg(srcPath, tmp);
      await encodeWithSharp(tmp, destPath, opts);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    return 'sips';
  }

  await encodeWithSharp(srcPath, destPath, opts);
  return 'sharp';
}

/* --------------------------------- 主流程 -------------------------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.source) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  if (!Number.isFinite(opts.max) || opts.max < 320) {
    console.error('错误：--max 必须是不小于 320 的数字');
    process.exit(1);
  }
  if (!Number.isFinite(opts.quality) || opts.quality < 1 || opts.quality > 100) {
    console.error('错误：--quality 必须是 1-100 的数字');
    process.exit(1);
  }

  if (!SUBSAMPLING.has(opts.subsample)) {
    console.error('错误：--subsample 只能是 4:2:0 / 4:2:2 / 4:4:4');
    process.exit(1);
  }

  const source = path.resolve(opts.source);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    console.error(`错误：源目录不存在或不是文件夹 → ${source}`);
    process.exit(1);
  }

  // 防止把 images/ 自己当源目录，那会生成 images/images/ 这样的嵌套
  const imagesAbs = path.resolve(TARGET_ROOT);
  if (source === imagesAbs || source.startsWith(imagesAbs + path.sep)) {
    console.error(`错误：源目录不能是项目里的 images/ 目录，请指向存放原始照片的文件夹`);
    process.exit(1);
  }

  const albums = await discoverAlbums(source);
  if (!albums.length) {
    console.error(`错误：在 ${source} 里没有找到任何照片`);
    process.exit(1);
  }

  console.log(`\n源目录 : ${source}`);
  console.log(`输出到 : ${TARGET_ROOT}`);
  console.log(`参数   : 长边 ${opts.max}px · 质量 ${opts.quality} · 色度抽样 ${opts.subsample}${opts.cleanName ? ' · 清理标题后缀' : ''}${opts.force ? ' · 强制重压' : ''}${opts.dryRun ? ' · 预览模式' : ''}\n`);

  const stats = { converted: 0, skipped: 0, failed: 0, renamed: 0, cleaned: 0 };
  let srcBytes = 0;
  let destBytes = 0;

  for (const album of albums) {
    const targetDir = path.join(TARGET_ROOT, album.name);
    console.log(`相册「${album.name}」→ images/${album.name}/  (${album.files.length} 张)`);

    if (!opts.dryRun) await fsp.mkdir(targetDir, { recursive: true });

    const taken = new Set();

    for (const file of album.files) {
      const srcPath = path.join(album.dir, file);
      const rawBase = file.replace(/\.[^.]+$/, '');
      const base = opts.cleanName ? cleanName(rawBase) : rawBase;
      if (base !== rawBase) stats.cleaned++;

      // 同一批里不同源文件重名时（如 IMG_1.HEIC 与 IMG_1.JPG）加序号，避免互相覆盖
      let renamed = false;
      let destPath = path.join(targetDir, `${base}.jpg`);
      if (taken.has(destPath)) {
        let n = 2;
        while (taken.has(path.join(targetDir, `${base}-${n}.jpg`))) n++;
        destPath = path.join(targetDir, `${base}-${n}.jpg`);
        renamed = true;
      }
      taken.add(destPath);

      const ext = path.extname(file).toLowerCase();

      if (!opts.force && await isUpToDate(srcPath, destPath)) {
        stats.skipped++;
        console.log(`  跳过   ${file}（已是最新）`);
        continue;
      }

      if (opts.dryRun) {
        stats.converted++;
        if (renamed) stats.renamed++;
        console.log(`  待处理 ${file} → ${path.basename(destPath)}`);
        continue;
      }

      try {
        const via = await compressOne(srcPath, destPath, ext, opts);
        const before = (await fsp.stat(srcPath)).size;
        const after = (await fsp.stat(destPath)).size;
        srcBytes += before;
        destBytes += after;
        stats.converted++;
        if (renamed) stats.renamed++;

        const change = before > 0 ? Math.round((after / before - 1) * 100) : 0;
        const sizeNote = `${formatSize(before)} → ${formatSize(after)}  ${change > 0 ? '+' : ''}${change}%`;
        console.log(`  完成   ${file} → ${path.basename(destPath)}  (${sizeNote}${via === 'sips' ? ', HEIC 转码' : ''})`);
      } catch (err) {
        stats.failed++;
        console.error(`  失败   ${file}：${err.message}`);
      }
    }
    console.log('');
  }

  console.log('─'.repeat(52));
  console.log(`完成 ${stats.converted} 张 · 跳过 ${stats.skipped} 张 · 失败 ${stats.failed} 张${stats.renamed ? ` · 重名改名 ${stats.renamed} 张` : ''}${stats.cleaned ? ` · 标题清理 ${stats.cleaned} 个` : ''}`);
  if (srcBytes > 0) {
    const change = Math.round((destBytes / srcBytes - 1) * 100);
    const note = change <= 0 ? `减小 ${-change}%` : `增大 ${change}%`;
    console.log(`总体积 ${formatSize(srcBytes)} → ${formatSize(destBytes)}  (${note})`);
    if (change > 0) console.log('体积变大通常是源图已经过良好压缩，或原图本身偏小所致。');
  }
  if (opts.dryRun) console.log('这是预览模式，没有写入任何文件。去掉 --dry-run 即正式执行。');
  console.log(`\n照片已就绪，打开网站即可看到（服务会自动重新扫描）。\n`);

  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n执行失败：${err.message}\n`);
  process.exit(1);
});
