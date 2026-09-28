/* ==========================================================================
   PeterGallery · 前端逻辑
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

  const lightbox = document.getElementById('lightbox');
  const lbImage = document.getElementById('lbImage');
  const lbTitle = document.getElementById('lbTitle');
  const lbAlbum = document.getElementById('lbAlbum');
  const lbExif = document.getElementById('lbExif');
  const lbIndexEl = document.getElementById('lbIndex');
  const lbLoader = document.getElementById('lbLoader');
  const lbStage = document.getElementById('lbStage');

  /** 网格尺寸，用于计算瀑布流高度 */
  let metrics = { colWidth: 0, gap: 14, rowUnit: 4 };

  /** 当前展示的照片列表（受相册筛选影响） */
  let photos = [];
  const ALBUM_ALL = '__all__';
  let activeAlbum = ALBUM_ALL;

  /* ------------------------------ 数据获取 ------------------------------ */

  async function init() {
    document.getElementById('year').textContent = new Date().getFullYear();

    let data;
    try {
      const res = await fetch('/api/photos');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      empty.hidden = false;
      empty.querySelector('h2').textContent = '加载失败';
      empty.querySelector('p').textContent = `无法读取照片数据：${err.message}`;
      return;
    }

    applySite(data.site);
    photos = data.photos || [];

    if (!photos.length) {
      empty.hidden = false;
      return;
    }

    setHero(data.photos[0]);
    renderChips(data.albums || []);
    renderGrid();
  }

  function applySite(site) {
    if (!site) return;
    if (site.title) {
      document.getElementById('brandText').textContent = site.title;
      document.title = `${site.title} · ${site.description || '摄影作品集'}`;
      // 首屏大标题支持用换行拆成多行
      const parts = String(site.title).trim().split(/\s+/);
      document.getElementById('heroTitle').innerHTML = parts.length > 1
        ? parts.map((p) => escapeHtml(p)).join('<br />')
        : escapeHtml(site.title);
    }
    if (site.author) {
      document.getElementById('heroAuthor').textContent = site.author;
      document.getElementById('footerAuthor').textContent = site.author;
    }
    if (site.tagline) document.getElementById('heroTagline').textContent = site.tagline;
  }

  function setHero(photo) {
    const bg = document.getElementById('heroBg');
    const url = `/api/image?p=${encodeURIComponent(photo.rel)}&w=2000&fit=cover`;
    const img = new Image();
    img.onload = () => {
      bg.style.backgroundImage = `url("${url}")`;
      bg.classList.add('is-ready');
    };
    img.src = url;
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
      btn.innerHTML = `${escapeHtml(album.name)}<span class="chip-count">${album.count}</span>`;
      btn.addEventListener('click', () => {
        if (activeAlbum === album.id) return;
        activeAlbum = album.id;
        [...chips.children].forEach((c) => c.classList.remove('is-active'));
        btn.classList.add('is-active');
        renderGrid();
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

  function renderGrid() {
    const list = currentPhotos();
    measure();
    grid.innerHTML = '';

    list.forEach((photo) => {
      const card = document.createElement('figure');
      card.className = 'card';
      card.dataset.w = photo.width;
      card.dataset.h = photo.height;
      card.style.gridRowEnd = `span ${spanFor(photo.width, photo.height)}`;

      const img = document.createElement('img');
      img.alt = photo.title || '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = `/api/image?p=${encodeURIComponent(photo.rel)}&w=800&fit=inside`;
      img.addEventListener('load', () => {
        img.classList.add('is-loaded');
        card.classList.add('is-loaded-card');
      });
      // 加载失败也要去掉骨架，避免一直闪着
      img.addEventListener('error', () => card.classList.add('is-loaded-card'));

      const meta = document.createElement('figcaption');
      meta.className = 'card-meta';
      const sub = photo.exif && photo.exif.camera ? photo.exif.camera : photo.album;
      meta.innerHTML = `<p class="card-title">${escapeHtml(photo.title)}</p>
        <p class="card-sub">${escapeHtml(sub || '')}</p>`;

      card.append(img, meta);
      card.addEventListener('click', () => openLightbox(list.indexOf(photo)));
      grid.appendChild(card);

      revealObserver.observe(card);
    });

    counter.textContent = `${list.length} 张`;
    requestAnimationFrame(layout);

    // 元素高度变化后重新定位，避免出现空洞
    window.setTimeout(layout, 220);
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

  function openLightbox(index) {
    if (index < 0) return;
    lbList = currentPhotos();
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

    const url = `/api/image?p=${encodeURIComponent(photo.rel)}&w=2000&fit=inside`;
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
    const order = ['camera', 'lens', 'focal', 'aperture', 'shutter', 'iso'];
    lbExif.innerHTML = order
      .filter((k) => exif[k])
      .map((k) => `<span>${escapeHtml(exif[k])}</span>`)
      .join('');
  }

  function preload(index) {
    const photo = lbList[index];
    if (!photo) return;
    new Image().src = `/api/image?p=${encodeURIComponent(photo.rel)}&w=2000&fit=inside`;
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
