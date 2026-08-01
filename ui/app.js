const queueTable = document.querySelector('#queueTable');
const queueEmpty = document.querySelector('#queueEmpty');
const fileInput = document.querySelector('#fileInput');
const dropzone = document.querySelector('#dropzone');
const dropTitle = document.querySelector('#dropTitle');
const dropMeta = document.querySelector('#dropMeta');
const startBatch = document.querySelector('#startBatch');
const clearQueue = document.querySelector('#clearQueue');
const addSamples = document.querySelector('#addSamples');
const mediaModeSwitch = document.querySelector('#mediaModeSwitch');
const qualitySwitch = document.querySelector('#qualitySwitch');
const qualityTitle = document.querySelector('#qualityTitle');
const imageOutputNote = document.querySelector('#imageOutputNote');
const previewPanel = document.querySelector('.preview-panel');
const outputPathPreview = document.querySelector('#outputPathPreview');
const outputPathHint = document.querySelector('#outputPathHint');
const queueSubtitle = document.querySelector('#queueSubtitle');
const previewTitle = document.querySelector('#previewTitle');
const previewChip = document.querySelector('#previewChip');
const sourceVideoPreview = document.querySelector('#sourceVideoPreview');
const sourceImagePreview = document.querySelector('#sourceImagePreview');
const outputVideoPreview = document.querySelector('#outputVideoPreview');
const outputImagePreview = document.querySelector('#outputImagePreview');
const sourcePreviewPlaceholder = document.querySelector('#sourcePreviewPlaceholder');
const outputPreviewPlaceholder = document.querySelector('#outputPreviewPlaceholder');
const previewContext = document.querySelector('#previewContext');
const statTotal = document.querySelector('#statTotal');
const statDone = document.querySelector('#statDone');
const statTime = document.querySelector('#statTime');
const batchSummary = document.querySelector('#batchSummary');
const batchSummaryMark = document.querySelector('#batchSummaryMark');
const batchSummaryTitle = document.querySelector('#batchSummaryTitle');
const batchSummaryMeta = document.querySelector('#batchSummaryMeta');
const retryFailed = document.querySelector('#retryFailed');
const mobileActionBar = document.querySelector('#mobileActionBar');
const mobileQueueCount = document.querySelector('#mobileQueueCount');
const mobileStartBatch = document.querySelector('#mobileStartBatch');
const activationModal = document.querySelector('#activationModal');
const openActivation = document.querySelector('#openActivation');
const openActivationSecondary = document.querySelector('#openActivationSecondary');
const closeActivation = document.querySelector('#closeActivation');
const bindMachine = document.querySelector('#bindMachine');
const activationStatus = document.querySelector('#activationStatus');
const activationCodeInput = document.querySelector('#activationCodeInput');
const licenseMachineText = document.querySelector('#licenseMachineText');
const modalMachineCode = document.querySelector('#modalMachineCode');
const copyMachineCode = document.querySelector('#copyMachineCode');

const LICENSE_API_URL = 'https://omni-license-worker.omni-watermark-helper.workers.dev';
const PREVIEW_MACHINE_CODE = 'PREVIEW-LOCAL';
const APP_VERSION = '0.1.5-ui';
const tauriInvoke = window.__TAURI__?.core?.invoke;
const isTauri = typeof tauriInvoke === 'function';
addSamples.hidden = isTauri;

const sampleFiles = [
  { name: '星空投影仪.mp4', size: 2_587_526, duration: 10, path: '/示例视频/星空投影仪.mp4' },
  {
    name: 'Vacuum_cleaning_spilled_milk_cereal.mp4',
    size: 2_560_872,
    duration: 10,
    path: '/示例视频/Vacuum_cleaning_spilled_milk_cereal.mp4'
  },
  {
    name: 'Woman_showing_white_teeth_after.mp4',
    size: 2_815_951,
    duration: 10,
    path: '/示例视频/Woman_showing_white_teeth_after.mp4'
  }
];

const mediaCopy = {
  video: {
    accept: 'video/*',
    title: '点击选择 10 秒视频',
    meta: '支持批量 MP4 / MOV · 9:16 / 16:9 · 本地处理',
    queueSubtitle: '固定 10 秒视频，按加入顺序批量处理',
    outputFallback: '同目录/去除水印/原文件名_去水印.mp4',
    outputHint: '每个视频会在自己的原文件夹旁新建「去除水印」文件夹',
    qualityTitle: '输出档位',
    previewTitle: '所选视频预览',
    previewChip: '未选择',
    emptyTitle: '暂无视频',
    emptyMeta: '队列等待文件',
    noFile: '没有识别到视频文件',
    acceptedLabel: '个视频',
    clickHint: '请点击上传区选择视频'
  },
  image: {
    accept: 'image/png,image/jpeg,image/webp',
    title: '点击选择 Gemini 图片',
    meta: '支持批量 PNG / JPG / WebP · 本地处理',
    queueSubtitle: 'Gemini 图片按加入顺序批量处理',
    outputFallback: '同目录/去除水印/原文件名_去水印.png',
    outputHint: '每张图片会在自己的原文件夹旁新建「去除水印」文件夹',
    qualityTitle: '图片输出',
    previewTitle: '所选图片预览',
    previewChip: '未选择',
    emptyTitle: '暂无图片',
    emptyMeta: '队列等待文件',
    noFile: '没有识别到图片文件',
    acceptedLabel: '张图片',
    clickHint: '请点击上传区选择图片'
  }
};

let queue = [];
let running = false;
let selectedId = null;
let selectedMode = 'video';
let dragDepth = 0;
let dropHintTimer = null;
let licenseActive = !isTauri;
let licenseMessage = isTauri ? '未激活' : '浏览器预览模式';
let machineCode = PREVIEW_MACHINE_CODE;
let storedLicenseCode = '';
let machineCodeReady = !isTauri;

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '--';
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

function createQueueItem(file, meta = {}) {
  const kind = meta.kind ?? mediaKindForFile(file);
  const sourcePath = file.path || file.webkitRelativePath || meta.path || file.name;
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    duration: kind === 'video' ? (meta.duration ?? 10) : 0,
    kind,
    sourcePath,
    outputDir: outputDirFor(sourcePath),
    outputPath: outputPathFor(sourcePath, file.name, kind),
    previewUrl: meta.previewUrl ?? (!isTauri && file instanceof File ? URL.createObjectURL(file) : ''),
    progress: 0,
    error: '',
    notice: '',
    simulated: meta.simulated ?? !isTauri,
    status: 'ready'
  };
}

function createQueueItemFromMediaInfo(info) {
  const kind = info.kind === 'image' ? 'image' : 'video';
  return {
    id: crypto.randomUUID(),
    name: info.name,
    size: info.size,
    duration: kind === 'video' ? (info.duration ?? 10) : 0,
    kind,
    sourcePath: info.path,
    outputDir: info.output_dir,
    outputPath: info.output_path,
    previewUrl: localPreviewUrl(info.path),
    progress: 0,
    error: '',
    notice: '',
    simulated: false,
    status: 'ready'
  };
}

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function directoryName(filePath) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '';
  return normalized.slice(0, index);
}

function baseNameWithoutExtension(fileName) {
  return String(fileName ?? 'video').replace(/\.[^.]+$/, '');
}

function extensionFor(fileName, fallback) {
  const match = String(fileName ?? '').match(/\.([^.]+)$/);
  return (match?.[1] ?? fallback).toLowerCase();
}

function outputDirFor(sourcePath) {
  const dir = directoryName(sourcePath);
  return dir ? `${dir}/去除水印` : '源文件夹/去除水印';
}

function outputPathFor(sourcePath, fileName, kind = 'video') {
  const extension = kind === 'image' ? extensionFor(fileName, 'png') : 'mp4';
  return `${outputDirFor(sourcePath)}/${baseNameWithoutExtension(fileName)}_去水印.${extension}`;
}

function parentDirFor(filePath) {
  return directoryName(filePath) || '源文件夹/去除水印';
}

function mergeQueueItems(newItems) {
  queue = [...queue, ...newItems];
  selectedId = selectedId ?? queue[0]?.id ?? null;
  hideBatchSummary();
  renderQueue();
  updateStats();
}

function renderQueue() {
  queueTable.innerHTML = '';
  queueEmpty.hidden = queue.length > 0;
  if (queue.length === 0) {
    queueTable.append(queueEmpty);
  }

  for (const item of queue) {
    const row = document.createElement('article');
    const invalidVideo = item.kind === 'video' && item.duration !== 10;
    const metaLabel = item.kind === 'image'
      ? `图片 · ${formatSize(item.size)}`
      : `视频 · ${formatSize(item.size)} · ${item.duration}s`;
    const progressLabel = item.status === 'done'
      ? item.simulated ? '演示' : item.kind === 'video' ? '已验证' : '已完成'
      : item.status === 'running'
        ? isTauri && !item.simulated ? '处理中' : `${item.progress}%`
        : '--';
    row.className = `queue-row ${item.kind} ${item.status}${item.id === selectedId ? ' selected' : ''}`;
    row.dataset.id = item.id;
    row.innerHTML = `
      <div class="file-name">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="${invalidVideo ? 'invalid' : ''}">${metaLabel}</span>
        <em title="${escapeHtml(item.error || item.notice || item.outputPath)}">${item.error ? '错误：' : item.notice ? '提示：' : '输出：'}${escapeHtml(item.error || item.notice || item.outputPath)}</em>
      </div>
      <span class="status ${item.status}">${statusLabel(item.status, item.kind, item.simulated)}</span>
      <div class="progress-cell">
        <div class="progress-track" aria-label="处理进度">
          <span style="--progress:${item.progress}%"></span>
        </div>
        <small>${progressLabel}</small>
      </div>
      <div class="row-actions">
        <button class="row-retry" type="button" ${item.status === 'error' ? '' : 'hidden'} title="重新处理此文件">重试</button>
        <button class="row-open" type="button" ${item.status === 'done' && !item.simulated ? '' : 'disabled'} title="打开输出文件夹">打开</button>
        <button class="row-remove" type="button" aria-label="移除 ${escapeHtml(item.name)}" title="从队列移除">×</button>
      </div>
    `;
    row.addEventListener('click', () => {
      selectedId = item.id;
      renderQueue();
      updateStats();
    });
    row.querySelector('.row-remove').addEventListener('click', (event) => {
      event.stopPropagation();
      releasePreviewUrl(item);
      queue = queue.filter((entry) => entry.id !== item.id);
      if (selectedId === item.id) selectedId = queue[0]?.id ?? null;
      hideBatchSummary();
      renderQueue();
      updateStats();
    });
    row.querySelector('.row-retry').addEventListener('click', (event) => {
      event.stopPropagation();
      retryQueueItems([item.id]);
    });
    row.querySelector('.row-open').addEventListener('click', (event) => {
      event.stopPropagation();
      openOutputForItem(item);
    });
    queueTable.append(row);
  }

  updateSelectedPreview();
}

function applyLicenseLock() {
  const hasProcessableItems = queue.some((item) => item.status !== 'done');
  const onlyFailedItems = hasProcessableItems && queue.every((item) => item.status === 'done' || item.status === 'error');
  document.body.classList.toggle('license-locked', !licenseActive);
  document.body.classList.toggle('license-active', licenseActive);
  dropzone.classList.toggle('locked', !licenseActive);
  fileInput.disabled = !licenseActive;
  startBatch.disabled = !licenseActive || running || queue.length === 0 || !hasProcessableItems;
  mobileStartBatch.disabled = startBatch.disabled;
  addSamples.disabled = selectedMode === 'image' || (!licenseActive && isTauri);
  clearQueue.disabled = !licenseActive && isTauri;
  for (const option of qualitySwitch.querySelectorAll('.quality-option')) {
    option.disabled = running || (!licenseActive && isTauri);
  }

  openActivation.dataset.licenseState = licenseActive ? 'active' : 'locked';
  openActivation.querySelector('span:nth-of-type(2)').textContent = licenseActive ? '已授权' : '未激活';
  openActivation.querySelector('strong').textContent = licenseActive ? '永久版' : '需激活';
  activationStatus.textContent = licenseMessage;
  licenseMachineText.textContent = machineCode;
  modalMachineCode.value = machineCode;
  bindMachine.disabled = !machineCodeReady;
  const actionLabel = running
    ? '处理中'
    : queue.length > 0 && !hasProcessableItems
      ? '全部通过'
      : onlyFailedItems ? '重试未通过项' : '开始去水印';
  startBatch.textContent = actionLabel;
  mobileStartBatch.textContent = actionLabel;
}

function statusLabel(status, kind, simulated = false) {
  if (status === 'running') return '处理中';
  if (status === 'done' && simulated) return '演示完成';
  if (status === 'done') return kind === 'video' ? '已验证' : '完成';
  if (status === 'error') return '未通过';
  return '待处理';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function updateStats() {
  const done = queue.filter((item) => item.status === 'done').length;
  const failed = queue.filter((item) => item.status === 'error').length;
  const pendingItems = queue.filter((item) => item.status === 'ready' || item.status === 'running');
  const pending = pendingItems.length;
  const pendingVideos = pendingItems.filter((item) => item.kind !== 'image').length;
  const pendingImages = pendingItems.filter((item) => item.kind === 'image').length;
  const fallbackPath = mediaCopy[selectedMode].outputFallback;
  statTotal.textContent = String(pending);
  statDone.textContent = String(done);
  statTime.textContent = queue.length === 0
    ? '--'
    : pending === 0
      ? failed > 0 ? '待重试' : '完成'
      : pendingVideos > 0
        ? `${Math.max(1, pendingVideos * 15)}s`
        : `${pendingImages}张`;
  mobileQueueCount.textContent = pending > 0
    ? `${pending} 个待处理`
    : failed > 0 ? `${failed} 个未通过` : queue.length > 0 ? '全部通过' : '0 个待处理';
  mobileActionBar.classList.toggle('has-items', queue.length > 0);
  outputPathPreview.textContent = selectedId
    ? queue.find((item) => item.id === selectedId)?.outputPath ?? fallbackPath
    : queue[0]?.outputPath ?? fallbackPath;
  applyLicenseLock();
}

function localPreviewUrl(filePath) {
  if (!filePath || !isTauri) return '';
  try {
    return window.__TAURI__?.core?.convertFileSrc?.(filePath) ?? '';
  } catch {
    return '';
  }
}

function releasePreviewUrl(item) {
  if (item?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
}

function clearPreviewMedia(element) {
  element.pause?.();
  element.removeAttribute('src');
  element.hidden = true;
  element.load?.();
}

function showPreviewMedia(element, url) {
  element.src = url;
  element.hidden = false;
  if (element.tagName === 'VIDEO') {
    element.onloadedmetadata = () => {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        element.currentTime = Math.min(0.15, element.duration / 2);
      }
    };
  }
}

function setPlaceholder(placeholder, title, meta) {
  placeholder.querySelector('strong').textContent = title;
  placeholder.querySelector('small').textContent = meta;
  placeholder.hidden = false;
}

function updateSelectedPreview() {
  const item = queue.find((entry) => entry.id === selectedId);
  for (const element of [sourceVideoPreview, sourceImagePreview, outputVideoPreview, outputImagePreview]) {
    clearPreviewMedia(element);
  }
  sourcePreviewPlaceholder.hidden = true;
  outputPreviewPlaceholder.hidden = true;

  if (!item) {
    previewChip.textContent = mediaCopy[selectedMode].previewChip;
    previewContext.querySelector('strong').textContent = '尚未选择文件';
    previewContext.querySelector('span').textContent = '队列中的选中项会显示在这里';
    setPlaceholder(sourcePreviewPlaceholder, '等待选择文件', '加入文件后显示真实内容');
    setPlaceholder(outputPreviewPlaceholder, '尚未处理', '完成后显示输出内容');
    return;
  }

  const sourceUrl = item.previewUrl || localPreviewUrl(item.sourcePath);
  const outputUrl = item.status === 'done' && !item.simulated ? localPreviewUrl(item.outputPath) : '';
  const sourceElement = item.kind === 'image' ? sourceImagePreview : sourceVideoPreview;
  const outputElement = item.kind === 'image' ? outputImagePreview : outputVideoPreview;

  previewChip.textContent = statusLabel(item.status, item.kind, item.simulated);
  previewContext.querySelector('strong').textContent = item.name;
  previewContext.querySelector('span').textContent = item.error
    ? `处理失败：${item.error}`
    : item.simulated && item.status === 'done'
      ? '演示队列不会生成真实输出'
      : item.notice || (item.status === 'done' ? '已完成，可打开输出文件夹' : '将在本机处理并保存到源文件旁');

  if (sourceUrl) {
    showPreviewMedia(sourceElement, sourceUrl);
  } else {
    setPlaceholder(sourcePreviewPlaceholder, item.name, item.simulated ? '示例队列不包含真实媒体' : '当前环境无法读取本地预览');
  }

  if (outputUrl) {
    showPreviewMedia(outputElement, outputUrl);
  } else if (item.status === 'error') {
    setPlaceholder(outputPreviewPlaceholder, '处理失败', '可在队列中点击重试');
  } else if (item.status === 'done' && item.simulated) {
    setPlaceholder(outputPreviewPlaceholder, '演示完成', '真实桌面处理后显示输出内容');
  } else {
    setPlaceholder(outputPreviewPlaceholder, '尚未处理', '完成后显示输出内容');
  }
}

function setMediaMode(mode) {
  if (!mediaCopy[mode] || running) return;
  selectedMode = mode;
  for (const option of mediaModeSwitch.querySelectorAll('.mode-option')) {
    const active = option.dataset.mode === mode;
    option.classList.toggle('active', active);
    option.setAttribute('aria-checked', String(active));
  }
  updateModeCopy();
  updateStats();
}

function updateModeCopy() {
  const copy = mediaCopy[selectedMode];
  document.body.dataset.mediaMode = selectedMode;
  fileInput.accept = copy.accept;
  dropTitle.textContent = copy.title;
  dropMeta.textContent = copy.meta;
  queueSubtitle.textContent = copy.queueSubtitle;
  outputPathHint.textContent = copy.outputHint;
  qualityTitle.textContent = copy.qualityTitle;
  previewTitle.textContent = copy.previewTitle;
  previewChip.textContent = copy.previewChip;
  qualitySwitch.hidden = selectedMode === 'image';
  imageOutputNote.hidden = selectedMode !== 'image';
  addSamples.textContent = selectedMode === 'image' ? '示例仅视频' : '载入示例';

  const emptyTitle = queueEmpty.querySelector('strong');
  const emptyMeta = queueEmpty.querySelector('span:last-child');
  if (emptyTitle) emptyTitle.textContent = copy.emptyTitle;
  if (emptyMeta) emptyMeta.textContent = copy.emptyMeta;

  if (!selectedId && queue.length === 0) {
    outputPathPreview.textContent = copy.outputFallback;
  }
}

async function addFiles(files) {
  const copy = mediaCopy[selectedMode];
  if (!licenseActive) {
    showActivation();
    setDropFeedback('rejected', '请先激活授权');
    return;
  }

  if (files.length === 0) return;

  const filePaths = files.map((file) => file.path).filter(Boolean);
  if (isTauri) {
    if (filePaths.length === files.length) {
      await addPathEntries(filePaths);
      return;
    }
    setDropFeedback('rejected', copy.clickHint);
    return;
  }

  const newItems = [];
  for (const file of files) {
    const kind = mediaKindForFile(file);
    const duration = kind === 'video' ? await readDuration(file).catch(() => 10) : 0;
    newItems.push(createQueueItem(file, { duration, kind }));
  }
  mergeQueueItems(newItems);
}

async function addPathEntries(paths) {
  const copy = mediaCopy[selectedMode];
  if (!licenseActive) {
    showActivation();
    setDropFeedback('rejected', '请先激活授权');
    return;
  }

  if (!isTauri) return;

  try {
    const media = await tauriInvoke('describe_media', { paths });
    const matchingMedia = media.filter((item) => item.kind === selectedMode);
    if (matchingMedia.length === 0) {
      setDropFeedback('rejected', copy.noFile);
      return;
    }

    mergeQueueItems(matchingMedia.map(createQueueItemFromMediaInfo));
    setDropFeedback('accepted', `已加入 ${matchingMedia.length} ${copy.acceptedLabel}`);
  } catch (error) {
    setDropFeedback('rejected', errorLabel(error));
    console.error(error);
  }
}

async function chooseMediaFromSystem() {
  const copy = mediaCopy[selectedMode];
  if (!licenseActive) {
    showActivation();
    setDropFeedback('rejected', '请先激活授权');
    return;
  }

  if (!isTauri) {
    fileInput.click();
    return;
  }

  try {
    const media = await tauriInvoke('choose_media', { kind: selectedMode });
    const matchingMedia = media.filter((item) => item.kind === selectedMode);
    if (media.length === 0) return;
    if (matchingMedia.length === 0) {
      setDropFeedback('rejected', copy.noFile);
      return;
    }
    mergeQueueItems(matchingMedia.map(createQueueItemFromMediaInfo));
    setDropFeedback('accepted', `已加入 ${matchingMedia.length} ${copy.acceptedLabel}`);
  } catch (error) {
    setDropFeedback('rejected', errorLabel(error));
    console.error(error);
  }
}

function readDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Math.round(video.duration));
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('metadata unavailable'));
    };
    video.src = url;
  });
}

async function runBatch(targetIds = null) {
  if (running || queue.length === 0) return;
  if (!licenseActive) {
    showActivation();
    return;
  }

  running = true;
  hideBatchSummary();
  startBatch.textContent = '处理中';
  startBatch.disabled = true;
  startBatch.classList.add('is-processing');
  mobileStartBatch.classList.add('is-processing');
  document.body.classList.add('processing-active');
  previewPanel.classList.add('processing');
  const executedIds = new Set();
  const batchQuality = qualitySwitch.querySelector('.quality-option.active')?.dataset.quality ?? 'fast';
  applyLicenseLock();

  for (const item of queue) {
    if (targetIds && !targetIds.has(item.id)) continue;
    if (item.status === 'done') continue;
    executedIds.add(item.id);
    selectedId = item.id;
    item.status = 'running';
    item.progress = 0;
    item.error = '';
    item.notice = '';
    renderQueue();
    updateStats();
    const progressFill = queueTable.querySelector(`[data-id="${item.id}"] .progress-track span`);

    let pulse = null;
    try {
      if (isTauri && !item.simulated) {
        pulse = startProgressPulse(item, progressFill);
        const result = item.kind === 'image'
          ? await tauriInvoke('clean_image', { inputPath: item.sourcePath })
          : await tauriInvoke('clean_video', {
            inputPath: item.sourcePath,
            quality: batchQuality
          });
        pulse.stop(true);
        pulse = null;
        item.outputPath = result.output_path ?? item.outputPath;
        item.outputDir = result.output_dir ?? parentDirFor(item.outputPath);
        item.size = result.output_size ?? item.size;
        if (String(result.stdout ?? '').includes('verification: repaired by strict second pass')) {
          item.notice = '已自动二次修复，并通过成品复检';
        } else if (item.kind === 'video') {
          item.notice = '成品复检通过';
        }
      } else {
        const step = item.kind === 'image' ? 20 : 8;
        for (let progress = step; progress <= 100; progress += step) {
          await wait(item.kind === 'image' ? 70 : 90);
          item.progress = Math.min(100, progress);
          progressFill?.style.setProperty('--progress', `${item.progress}%`);
        }
      }

      item.status = 'done';
      item.progress = 100;
    } catch (error) {
      pulse?.stop(false);
      item.status = 'error';
      item.error = errorLabel(error);
      item.progress = 0;
      console.error(error);
    }

    renderQueue();
    updateStats();
  }

  running = false;
  startBatch.classList.remove('is-processing');
  mobileStartBatch.classList.remove('is-processing');
  document.body.classList.remove('processing-active');
  previewPanel.classList.remove('processing');
  updateStats();
  showBatchSummary(executedIds);
}

function retryQueueItems(itemIds) {
  if (running) return;
  const targetIds = new Set(itemIds);
  for (const item of queue) {
    if (!targetIds.has(item.id)) continue;
    item.status = 'ready';
    item.progress = 0;
    item.error = '';
  }
  hideBatchSummary();
  renderQueue();
  updateStats();
  runBatch(targetIds);
}

function hideBatchSummary() {
  batchSummary.hidden = true;
}

function showBatchSummary(executedIds) {
  const batchItems = queue.filter((item) => executedIds.has(item.id));
  const verified = batchItems.filter((item) => item.status === 'done' && !item.simulated).length;
  const simulated = batchItems.filter((item) => item.status === 'done' && item.simulated).length;
  const failed = batchItems.filter((item) => item.status === 'error').length;
  if (verified + simulated + failed === 0) return;

  batchSummaryTitle.textContent = failed > 0
    ? '本批次已结束，部分文件未通过'
    : simulated > 0 && verified === 0 ? '演示处理完成' : '本批次全部通过';
  batchSummaryMeta.textContent = [
    verified > 0 ? `通过 ${verified} 个` : '',
    simulated > 0 ? `演示 ${simulated} 个` : '',
    failed > 0 ? `未通过 ${failed} 个` : ''
  ].filter(Boolean).join('，');
  batchSummaryMark.textContent = failed > 0 ? '!' : '✓';
  retryFailed.hidden = failed === 0;
  batchSummary.classList.toggle('has-errors', failed > 0);
  batchSummary.hidden = false;
}

async function openOutputForItem(item) {
  if (!isTauri) return;

  try {
    await tauriInvoke('open_output', { path: item.outputPath });
  } catch (error) {
    item.status = 'error';
    item.error = errorLabel(error);
    renderQueue();
    updateStats();
  }
}

function startProgressPulse(item, progressFill) {
  let progress = 6;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    progress = Math.min(92, progress + (progress < 60 ? 4 : 1));
    item.progress = progress;
    progressFill?.style.setProperty('--progress', `${progress}%`);
  }, 650);

  return {
    stop(completed = true) {
      stopped = true;
      clearInterval(timer);
      item.progress = completed ? 100 : 0;
      progressFill?.style.setProperty('--progress', completed ? '100%' : '0%');
    }
  };
}

async function copyMachineCodeToClipboard() {
  if (!machineCodeReady) return;
  try {
    await navigator.clipboard.writeText(machineCode);
    copyMachineCode.textContent = '已复制';
    setTimeout(() => {
      copyMachineCode.textContent = '复制';
    }, 1200);
  } catch {
    modalMachineCode.select();
    document.execCommand('copy');
    copyMachineCode.textContent = '已复制';
  }
}

function errorLabel(error) {
  const message = typeof error === 'string' ? error : error?.message ?? '处理失败，请检查文件';
  if (message.includes('无法可靠定位 Omni 水印')) {
    return '未能可靠定位水印，已阻止输出。请确认是包含右下角 Omni 星形水印的原始视频后重试';
  }
  if (message.includes('成品复检仍检测到明显水印残留')) {
    return '成品复检未通过，已阻止输出。请重试此文件';
  }
  if (message.includes('未返回成品复检通过标记')) {
    return '成品未通过复检，已阻止输出。请重试此文件';
  }
  return message;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showActivation() {
  activationModal.hidden = false;
  document.body.classList.add('modal-open');
  activationModal.querySelector('input:not([readonly])')?.focus();
}

function hideActivation() {
  activationModal.hidden = true;
  document.body.classList.remove('modal-open');
}

async function activateLicense() {
  if (!machineCodeReady) {
    activationStatus.textContent = '正在读取本机机器码，请稍候';
    return;
  }

  const code = activationCodeInput.value.trim();
  if (!code) {
    activationStatus.textContent = '请先输入激活码';
    activationCodeInput.focus();
    return;
  }

  bindMachine.disabled = true;
  activationStatus.textContent = '正在连接授权服务器';

  try {
    const { response, data } = await requestLicense('activate', code);

    if (!response.ok) {
      activationStatus.textContent = activationErrorLabel(data.error);
      return;
    }

    const licensePayload = { ...data, code };
    localStorage.setItem('omniLicense', JSON.stringify(licensePayload));
    if (isTauri) {
      await tauriInvoke('save_license', { payload: licensePayload });
    }
    licenseActive = true;
    licenseMessage = '授权有效';
    storedLicenseCode = code;
    activationStatus.textContent = '绑定成功，已保存本机授权';
    applyLicenseLock();
  } catch (error) {
    activationStatus.textContent = isAbortError(error)
      ? '连接授权服务器超时，请稍后重试'
      : errorLabel(error);
  } finally {
    bindMachine.disabled = false;
  }
}

async function refreshLicenseState() {
  if (!isTauri) {
    machineCode = PREVIEW_MACHINE_CODE;
    machineCodeReady = true;
    licenseActive = true;
    licenseMessage = '浏览器预览模式';
    applyLicenseLock();
    return;
  }

  try {
    const state = await tauriInvoke('license_state');
    machineCode = state.machine_code ?? machineCode;
    machineCodeReady = true;
    licenseActive = Boolean(state.active);
    licenseMessage = state.message ?? (licenseActive ? '授权有效' : '未激活');
    storedLicenseCode = state.code ?? '';
    if (storedLicenseCode) {
      if (!licenseActive) {
        licenseMessage = '正在验证授权服务器';
        applyLicenseLock();
      }
      await validateStoredLicenseOnline(storedLicenseCode, { allowOffline: licenseActive });
    }
  } catch (error) {
    machineCodeReady = false;
    licenseActive = false;
    licenseMessage = errorLabel(error);
  }

  applyLicenseLock();
}

async function validateStoredLicenseOnline(code, options = {}) {
  try {
    const { response, data } = await requestLicense('validate', code);

    if (!response.ok) {
      licenseActive = false;
      licenseMessage = activationErrorLabel(data.error);
      applyLicenseLock();
      return;
    }

    const licensePayload = { ...data, code };
    localStorage.setItem('omniLicense', JSON.stringify(licensePayload));
    await tauriInvoke('save_license', { payload: licensePayload });
    licenseActive = true;
    licenseMessage = '授权有效，本机永久可用';
    applyLicenseLock();
  } catch {
    if (options.allowOffline) {
      licenseMessage = '授权有效，本机永久可用';
    } else {
      licenseActive = false;
      licenseMessage = '联网验证失败，请检查网络后重试';
    }
    applyLicenseLock();
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

async function requestLicense(endpoint, code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${LICENSE_API_URL}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        code,
        machineCode,
        appVersion: APP_VERSION
      })
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

function activationErrorLabel(error) {
  if (error === 'invalid_code') return '激活码不存在';
  if (error === 'already_bound') return '激活码已绑定其他电脑';
  if (error === 'code_disabled') return '激活码已停用';
  if (error === 'not_active') return '激活码未启用';
  if (error === 'machine_mismatch') return '授权不属于本机';
  if (error === 'missing_code_or_machine') return '激活码或机器码缺失';
  return '激活失败，请检查激活码';
}

function isVideoFile(file) {
  if (file.type?.startsWith('video/')) return true;
  return /\.(mp4|mov|m4v|webm)$/i.test(file.name ?? '');
}

function isImageFile(file) {
  if (file.type?.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp)$/i.test(file.name ?? '');
}

function mediaKindForFile(file) {
  return isImageFile(file) ? 'image' : 'video';
}

function collectFilesForMode(fileList, mode = selectedMode) {
  const matcher = mode === 'image' ? isImageFile : isVideoFile;
  return [...(fileList ?? [])].filter(matcher);
}

function setDropFeedback(state, message = '') {
  clearTimeout(dropHintTimer);
  dropzone.classList.toggle('dragging', state === 'dragging');
  dropzone.classList.toggle('drop-accepted', state === 'accepted');
  dropzone.classList.toggle('drop-rejected', state === 'rejected');

  if (message) {
    dropzone.dataset.dropHint = message;
  } else {
    delete dropzone.dataset.dropHint;
  }

  if (state === 'accepted' || state === 'rejected') {
    dropHintTimer = setTimeout(clearDropFeedback, 1200);
  }
}

function clearDropFeedback() {
  dragDepth = 0;
  dropzone.classList.remove('dragging', 'drop-accepted', 'drop-rejected');
  delete dropzone.dataset.dropHint;
}

function hasDraggedFiles(event) {
  return [...(event.dataTransfer?.types ?? [])].includes('Files');
}

function preventFileNavigation(event) {
  if (hasDraggedFiles(event)) {
    event.preventDefault();
  }
}

function handleDragEnter(event) {
  const copy = mediaCopy[selectedMode];
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  if (!licenseActive) {
    setDropFeedback('rejected', '请先激活授权');
    return;
  }
  setDropFeedback('rejected', copy.clickHint);
}

function handleDragOver(event) {
  const copy = mediaCopy[selectedMode];
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  if (!licenseActive) {
    event.dataTransfer.dropEffect = 'none';
    setDropFeedback('rejected', '请先激活授权');
    return;
  }
  event.dataTransfer.dropEffect = 'none';
  setDropFeedback('rejected', copy.clickHint);
}

function handleDragLeave(event) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) clearDropFeedback();
}

function handleDrop(event) {
  const copy = mediaCopy[selectedMode];
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;

  if (!licenseActive) {
    showActivation();
    setDropFeedback('rejected', '请先激活授权');
    return;
  }

  const paths = [...event.dataTransfer.files].map((file) => file.path).filter(Boolean);
  if (isTauri) {
    if (paths.length > 0) {
      addPathEntries(paths);
      return;
    }
    setDropFeedback('rejected', copy.clickHint);
    return;
  }

  const files = collectFilesForMode(event.dataTransfer.files);
  if (files.length === 0) {
    setDropFeedback('rejected', copy.noFile);
    return;
  }

  setDropFeedback('accepted', `已加入 ${files.length} ${copy.acceptedLabel}`);
  addFiles(files);
}

fileInput.addEventListener('change', (event) => {
  const copy = mediaCopy[selectedMode];
  if (!licenseActive) {
    showActivation();
    setDropFeedback('rejected', '请先激活授权');
    event.target.value = '';
    return;
  }

  if (isTauri) {
    setDropFeedback('rejected', '请点击上传区选择文件');
    event.target.value = '';
    return;
  }

  const files = collectFilesForMode(event.target.files);
  if (files.length === 0) {
    setDropFeedback('rejected', copy.noFile);
  } else {
    setDropFeedback('accepted', `已加入 ${files.length} ${copy.acceptedLabel}`);
    addFiles(files);
  }
  event.target.value = '';
});

dropzone.addEventListener('click', (event) => {
  if (event.target === fileInput && !isTauri) return;
  event.preventDefault();
  chooseMediaFromSystem();
});

mediaModeSwitch.addEventListener('click', (event) => {
  const button = event.target.closest('.mode-option');
  if (!button) return;
  setMediaMode(button.dataset.mode);
});

window.addEventListener('dragover', preventFileNavigation);
window.addEventListener('drop', preventFileNavigation);
dropzone.addEventListener('dragenter', handleDragEnter);
dropzone.addEventListener('dragover', handleDragOver);
dropzone.addEventListener('dragleave', handleDragLeave);
dropzone.addEventListener('drop', handleDrop);

startBatch.addEventListener('click', () => runBatch());
mobileStartBatch.addEventListener('click', () => runBatch());

clearQueue.addEventListener('click', () => {
  queue.forEach(releasePreviewUrl);
  queue = [];
  selectedId = null;
  hideBatchSummary();
  renderQueue();
  updateStats();
});

addSamples.addEventListener('click', () => {
  if (selectedMode === 'image') return;
  if (!licenseActive && isTauri) {
    showActivation();
    return;
  }

  queue = sampleFiles.map((file) => createQueueItem(file, { simulated: true }));
  selectedId = queue[0]?.id ?? null;
  hideBatchSummary();
  renderQueue();
  updateStats();
});

qualitySwitch.addEventListener('click', (event) => {
  const button = event.target.closest('.quality-option');
  if (!button || running || button.disabled) return;

  for (const option of qualitySwitch.querySelectorAll('.quality-option')) {
    option.classList.toggle('active', option === button);
    option.setAttribute('aria-checked', String(option === button));
  }
});

openActivation.addEventListener('click', showActivation);
openActivationSecondary.addEventListener('click', showActivation);
closeActivation.addEventListener('click', hideActivation);

activationModal.addEventListener('click', (event) => {
  if (event.target === activationModal) hideActivation();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !activationModal.hidden) hideActivation();
});

bindMachine.addEventListener('click', activateLicense);
copyMachineCode.addEventListener('click', copyMachineCodeToClipboard);
retryFailed.addEventListener('click', () => {
  retryQueueItems(queue.filter((item) => item.status === 'error').map((item) => item.id));
});

updateModeCopy();
renderQueue();
refreshLicenseState();
updateStats();
