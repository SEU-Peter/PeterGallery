/* ==========================================================================
   PeterGallery · 前端逻辑

   纯静态：数据来自构建时生成的 photos.json，图片是 _site/media/ 下的 webp。
   所有路径都用相对路径，这样部署在 GitHub Pages 的子路径
   （https://<用户名>.github.io/PeterGallery/）下也能正常工作。
   ========================================================================== */

(() => {
  'use strict';

  const grid = document.getElementById('grid');
  const chips = document.getElementById('chips');
  const chipsToggle = document.getElementById('chipsToggle');
  const toolbar = document.getElementById('toolbar');
  const counter = document.getElementById('counter');
  const empty = document.getElementById('empty');
  const header = document.getElementById('siteHeader');
  const featured = document.getElementById('featured');
  const featuredGrid = document.getElementById('featuredGrid');
  const albums = document.getElementById('albums');
  const albumGrid = document.getElementById('albumGrid');
  const contactIntro = document.getElementById('contactIntro');
  const contactLinks = document.getElementById('contactLinks');

  const lightbox = document.getElementById('lightbox');
  const lbImage = document.getElementById('lbImage');
  const lbTitle = document.getElementById('lbTitle');
  const lbAlbum = document.getElementById('lbAlbum');
  const lbExif = document.getElementById('lbExif');
  const lbIndexEl = document.getElementById('lbIndex');
  const lbLoader = document.getElementById('lbLoader');
  const lbStage = document.getElementById('lbStage');

  /** 网格尺寸，用于计算瀑布流高度 */
  let metrics = { colWidth: 0, gap: 14, rowUnit: 1 };

  /** 当前展示的照片列表（受相册筛选影响） */
  let photos = [];
  let siteConfig = {};
  const ALBUM_ALL = '__all__';
  let activeAlbum = ALBUM_ALL;

  /* ------------------------------ 数据获取 ------------------------------ */

  async function init() {
    document.getElementById('year').textContent = new Date().getFullYear();

    let data;
    try {
      // 相对路径：构建时由 scripts/build-static.js 生成
      const res = await fetch('photos.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      empty.hidden = false;
      empty.querySelector('h2').textContent = '加载失败';
      empty.querySelector('p').innerHTML =
        `无法读取照片数据（${escapeHtml(err.message)}）。<br />` +
        '如果本地预览，请先执行 <code>npm run build</code>，再用 <code>npm run preview</code> 打开。';
      return;
    }

    applySite(data.site);
    photos = data.photos || [];

    if (!photos.length) {
      empty.hidden = false;
      return;
    }

    // 首屏背景每次刷新随机挑一张
    setHero(pickHero(photos)?.large);
    renderFeatured();
    renderAlbums(data.albums || []);
    renderChips(data.albums || []);
    renderGrid();
  }

  function applySite(site) {
    siteConfig = site || {};
    if (siteConfig.title) {
      document.getElementById('brandText').textContent = siteConfig.title;
      document.title = `${siteConfig.title} · ${siteConfig.description || '摄影作品集'}`;
      // 首屏大标题支持用换行拆成多行
      const parts = String(siteConfig.title).trim().split(/\s+/);
      document.getElementById('heroTitle').innerHTML = parts.length > 1
        ? parts.map((p) => escapeHtml(p)).join('<br />')
        : escapeHtml(siteConfig.title);
    }
    if (siteConfig.author) {
      document.getElementById('heroAuthor').textContent = siteConfig.author;
      document.getElementById('footerAuthor').textContent = siteConfig.author;
    }
    if (siteConfig.tagline) document.getElementById('heroTagline').textContent = siteConfig.tagline;
    renderContact(siteConfig.contact);
  }

  function renderContact(contact = {}) {
    if (contact.intro) contactIntro.textContent = contact.intro;
    const links = [];
    if (contact.email) links.push({ label: contact.email, url: `mailto:${contact.email}` });
    if (Array.isArray(contact.links)) links.push(...contact.links);

    contactLinks.innerHTML = '';
    links.filter((link) => link && link.label && link.url).forEach((link) => {
      const a = document.createElement('a');
      a.href = link.url;
      a.textContent = link.label;
      if (/^https?:\/\//i.test(link.url)) {
        a.target = '_blank';
        a.rel = 'noreferrer';
      }
      contactLinks.appendChild(a);
    });
    contactLinks.hidden = !contactLinks.children.length;
  }

  /**
   * 首屏背景图：每次刷新随机挑一张。
   * 只从横幅照片里挑——首屏容器很宽（约 2:1），竖幅照片用 cover 会被裁成一条，
   * 基本看不出内容。若一张横幅都没有则退回全部照片。
   */
  function pickHero(list) {
    if (!list.length) return null;
    const landscape = list.filter((p) => p.width >= p.height);
    const pool = landscape.length ? landscape : list;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function setHero(url) {
    if (!url) return;
    const bg = document.getElementById('heroBg');
    const img = new Image();
    img.onload = () => {
      bg.style.backgroundImage = `url("${url}")`;
      bg.classList.add('is-ready');
    };
    img.src = url;
  }

  /* -------------------------- 精选与相册入口 -------------------------- */

  function featuredPhotos() {
    const selected = new Map(photos.map((photo) => [photo.source, photo]));
    return (siteConfig.featured || []).map((source) => selected.get(source)).filter(Boolean);
  }

  function renderFeatured() {
    const list = featuredPhotos();
    featuredGrid.innerHTML = '';
    featured.hidden = !list.length;
    list.forEach((photo, index) => {
      const card = createPhotoCard(photo, () => openLightbox(index, list), false);
      featuredGrid.appendChild(card);
      revealObserver.observe(card);
    });
  }

  function renderAlbums(albumList) {
    albumGrid.innerHTML = '';
    albums.hidden = !albumList.length;
    albumList.forEach((album) => {
      const cover = photos.find((photo) => photo.album === album.id);
      if (!cover) return;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'album-card';
      card.setAttribute('aria-label', `浏览相册：${album.name}，共 ${album.count} 张`);

      const image = document.createElement('img');
      image.src = cover.thumb;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';

      const info = document.createElement('span');
      info.className = 'album-card-info';
      info.innerHTML = `<span class="album-card-name">${escapeHtml(album.name)}</span>
        <span class="album-card-count">${album.count} 张作品</span>`;
      card.append(image, info);
      card.addEventListener('click', () => {
        setActiveAlbum(album.id);
        document.getElementById('allWork').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      albumGrid.appendChild(card);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* ------------------------------ 相册筛选 ------------------------------ */

  function renderChips(albums) {
    // 按照片数量降序，数量相同再按名称排，保证顺序稳定
    const sorted = [...albums].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'),
    );
    const items = [{ id: ALBUM_ALL, name: '全部', count: photos.length }, ...sorted];
    chips.innerHTML = '';

    items.forEach((album) => {
      const btn = document.createElement('button');
      btn.className = 'chip' + (album.id === activeAlbum ? ' is-active' : '');
      btn.type = 'button';
      btn.dataset.albumId = album.id;
      btn.innerHTML = `${escapeHtml(album.name)}<span class="chip-count">${album.count}</span>`;
      btn.addEventListener('click', () => {
        setActiveAlbum(album.id);
      });
      chips.appendChild(btn);
    });

    setChipsExpanded(false);
  }

  /**
   * 分类多到一行放不下时，横向滚动条是隐藏的，鼠标用户够不到后面的条目，
   * 所以给一个显式的展开/收起按钮。
   */
  function setChipsExpanded(expanded) {
    chips.classList.toggle('is-expanded', expanded);
    toolbar.classList.toggle('is-tall', expanded);

    if (expanded) {
      chipsToggle.hidden = false;
      chipsToggle.textContent = '收起';
      return;
    }

    // 收起状态下只有真的溢出才显示按钮（读取会触发一次重排，可接受）
    chipsToggle.hidden = chips.scrollWidth <= chips.clientWidth + 1;
    chipsToggle.textContent = `展开全部 ${chips.children.length - 1} 个分类`;
  }

  chipsToggle.addEventListener('click', () => {
    setChipsExpanded(!chips.classList.contains('is-expanded'));
  });

  /* -------------------------------- 网格 -------------------------------- */

  function currentPhotos() {
    return activeAlbum === ALBUM_ALL ? photos : photos.filter((p) => p.album === activeAlbum);
  }

  function setActiveAlbum(albumId) {
    if (activeAlbum === albumId) return;
    activeAlbum = albumId;
    [...chips.children].forEach((chip) => {
      chip.classList.toggle('is-active', chip.dataset.albumId === albumId);
    });
    renderGrid();
  }

  function renderGrid() {
    const list = currentPhotos();
    measure();
    grid.innerHTML = '';

    list.forEach((photo, index) => {
      const card = createPhotoCard(photo, () => openLightbox(index, list), true);
      grid.appendChild(card);

      revealObserver.observe(card);
    });

    counter.textContent = `${list.length} 张`;
    requestAnimationFrame(layout);

    // 元素高度变化后重新定位，避免出现空洞
    window.setTimeout(layout, 220);
  }

  function createPhotoCard(photo, onClick, masonry) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset.w = photo.width;
    card.dataset.h = photo.height;
    card.setAttribute('aria-label', `查看照片：${photo.title}，${photo.album}`);
    if (masonry) card.style.gridRowEnd = `span ${spanFor(photo.width, photo.height)}`;

    const img = document.createElement('img');
    img.alt = photo.title || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = photo.thumb;
    img.addEventListener('load', () => {
      img.classList.add('is-loaded');
      card.classList.add('is-loaded-card');
    });
    img.addEventListener('error', () => card.classList.add('is-loaded-card'));

    const meta = document.createElement('span');
    meta.className = 'card-meta';
    const camera = photo.exif && photo.exif.camera;
    const tags = [
      camera ? `<span class="card-tag">${escapeHtml(camera)}</span>` : '',
      `<span class="card-tag">${escapeHtml(photo.album)}</span>`,
    ].join('');
    meta.innerHTML = `<span class="card-title">${escapeHtml(photo.title)}</span>
      <span class="card-tags">${tags}</span>`;

    card.append(img, meta);
    card.addEventListener('click', onClick);
    return card;
  }

  function measure() {
    const cs = getComputedStyle(grid);
    const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    // 列间距用来算列宽；行间距由 .card 的 margin-bottom 提供，从 :root 的 --gap 读
    const columnGap = parseFloat(cs.columnGap) || 0;
    const rowUnit = parseFloat(cs.gridAutoRows) || 1;
    const rowGap = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--gap'),
    ) || 0;
    const total = grid.clientWidth;
    metrics = { colWidth: (total - columnGap * (cols - 1)) / cols, gap: rowGap, rowUnit };
  }

  /**
   * 卡片高度 = 列宽 / 原图宽高比，再换算成网格行跨度。
   * 卡片底部有一个 gap 高的外边距充当行间距，所以跨度要多算 gap / rowUnit 行，
   * 这样算出的卡片高度与照片比例误差在 0.5px 内，照片不会被裁切。
   */
  function spanFor(w, h) {
    const ratio = w && h ? w / h : 1;
    const imageHeight = metrics.colWidth / ratio;
    return Math.max(1, Math.round((imageHeight + metrics.gap) / metrics.rowUnit));
  }

  function layout() {
    if (!metrics.colWidth) return;
    [...grid.children].forEach((card) => {
      card.style.gridRowEnd = `span ${spanFor(Number(card.dataset.w), Number(card.dataset.h))}`;
    });
  }

  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { rootMargin: '120px 0px' });

  /* -------------------------------- 灯箱 -------------------------------- */

  let lbList = [];
  let lbIndex = 0;

  function openLightbox(index, list = currentPhotos()) {
    if (index < 0) return;
    lbList = list;
    lbIndex = index;
    lightbox.hidden = false;
    document.body.classList.add('lb-open');
    requestAnimationFrame(() => lightbox.classList.add('is-open'));
    showCurrent();
  }

  function closeLightbox() {
    lightbox.classList.remove('is-open');
    document.body.classList.remove('lb-open');
    window.setTimeout(() => {
      lightbox.hidden = true;
      lbImage.removeAttribute('src');
    }, 300);
  }

  function showCurrent() {
    const photo = lbList[lbIndex];
    if (!photo) return;

    lbLoader.classList.add('is-active');
    lbImage.classList.remove('is-loaded');
    lbTitle.textContent = photo.title;
    lbAlbum.textContent = photo.album;
    lbIndexEl.textContent = `${lbIndex + 1} / ${lbList.length}`;
    renderExif(photo.exif);

    const url = photo.large;
    const pre = new Image();
    pre.onload = () => {
      lbImage.src = url;
      lbImage.alt = photo.title;
      requestAnimationFrame(() => lbImage.classList.add('is-loaded'));
      lbLoader.classList.remove('is-active');
    };
    pre.onerror = () => lbLoader.classList.remove('is-active');
    pre.src = url;

    preload(lbIndex + 1);
    preload(lbIndex - 1);
  }

  function renderExif(exif) {
    if (!exif) {
      lbExif.innerHTML = '';
      return;
    }
    // date 放最后并单独给个样式，和光学参数区分开
    const order = ['camera', 'lens', 'focal', 'aperture', 'shutter', 'iso', 'date'];
    lbExif.innerHTML = order
      .filter((k) => exif[k])
      .map((k) => `<span${k === 'date' ? ' class="lb-date"' : ''}>${escapeHtml(exif[k])}</span>`)
      .join('');
  }

  function preload(index) {
    const photo = lbList[index];
    if (!photo) return;
    new Image().src = photo.large;
  }

  function step(delta) {
    if (!lbList.length) return;
    lbIndex = (lbIndex + delta + lbList.length) % lbList.length;
    showCurrent();
  }

  /* -------------------------------- 事件 -------------------------------- */

  document.getElementById('lbClose').addEventListener('click', closeLightbox);
  document.getElementById('lbPrev').addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
  document.getElementById('lbNext').addEventListener('click', (e) => { e.stopPropagation(); step(1); });

  // 点击图片以外的空白区域关闭
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox || e.target === lbStage || e.target === lbImage.parentElement) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  });

  // 移动端左右滑动切换
  let touchX = null;
  lightbox.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const delta = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(delta) > 55) step(delta < 0 ? 1 : -1);
  }, { passive: true });

  // 滚动时给导航加背景
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 40);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // 尺寸变化重新计算瀑布流，并重新判断分类是否需要展开按钮
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      measure();
      layout();
      if (!chips.classList.contains('is-expanded')) setChipsExpanded(false);
    }, 160);
  });

  init();
})();
