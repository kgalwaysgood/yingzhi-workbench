const token = document.querySelector('meta[name="workbench-token"]').content;
const selectedCreators = new Set();
const selectedWorks = new Set();
const selectedTranscripts = new Set();
let snapshot = null;
let pollingJobId = null;
let worksBackRoute = 'source';
const routes = ['source', 'creators', 'works', 'transcripts', 'knowledge'];
const routeNames = ['输入学习目标', '选择博主', '挑选作品', '核对文字稿', '审核知识'];

const $ = id => document.getElementById(id);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(url, label) {
  const node = element('a', label);
  node.href = url;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
}

async function api(url, body) {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `请求失败：HTTP ${response.status}`);
  return payload;
}

function showTask(title, status, message, logs = []) {
  $('taskPanel').hidden = false;
  $('taskTitle').textContent = title;
  $('taskStatus').textContent = status;
  $('taskMessage').textContent = message;
  $('taskLogs').textContent = logs.join('').slice(-3500);
}

function showError(error) {
  showTask('操作未完成', '需要处理', error.message || String(error));
}

function currentRoute() {
  const name = location.hash.replace(/^#\/?/, '');
  return routes.includes(name) ? name : 'source';
}

function renderRoute() {
  const name = currentRoute();
  const index = routes.indexOf(name);
  for (const route of routes) $(route).hidden = route !== name;
  for (const item of document.querySelectorAll('[data-route]')) {
    if (item.dataset.route === name) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  $('screenProgress').textContent = `STEP ${String(index + 1).padStart(2, '0')} / 05`;
  $('screenContext').textContent = routeNames[index];
  $('appShell').classList.toggle('review-layout', name === 'transcripts' || name === 'knowledge');
  $('inspector').hidden = name !== 'transcripts' && name !== 'knowledge';
  $('worksBackButton').textContent = worksBackRoute === 'creators' ? '← 返回博主选择' : '← 返回输入';
  document.title = `${routeNames[index]} | 影知工坊`;
  window.scrollTo(0, 0);
}

function navigate(name) {
  if (!routes.includes(name)) return;
  if (location.hash === `#/${name}`) renderRoute();
  else location.hash = `/${name}`;
}

async function pollJob(id) {
  if (pollingJobId === id) return;
  pollingJobId = id;
  while (pollingJobId === id) {
    try {
      const job = await api(`/api/jobs/${id}`);
      const names = { login: '抖音登录', discover: '发现候选博主', prepare: '列出博主作品', download: '下载并本地转写', summarize: '本地知识提炼', 'install-model': '安装本地模型' };
      showTask(names[job.kind] || '本地任务', job.status === 'running' ? '处理中' : job.status === 'completed' ? '已完成' : '未完成',
        job.status === 'running' ? '可继续浏览页面；请勿关闭工作台。' : job.status === 'completed' ? '本步骤已完成，请核对结果再继续。' : job.error || '请查看日志并重试。', job.logs);
      if (job.status !== 'running') {
        pollingJobId = null;
        await refresh();
        if (job.status === 'completed') {
          const next = { discover: 'creators', prepare: 'works', download: 'transcripts', summarize: 'knowledge' }[job.kind];
          if (next) navigate(next);
        }
        return;
      }
    } catch (error) { showError(error); pollingJobId = null; return; }
    await pause(1100);
  }
}

async function startJob(url, body) {
  try {
    const { jobId } = await api(url, body);
    showTask('任务已启动', '处理中', '请稍候，处理进度会持续更新。');
    await refresh();
    pollJob(jobId);
  } catch (error) { showError(error); }
}

function renderReadiness(data) {
  const labels = [
    ['抖音登录', data.ready.cookies],
    ['本地转写', data.ready.transcription],
    ['本地总结', data.ready.summaryModel],
  ];
  $('readiness').replaceChildren(...labels.map(([name, ready]) => {
    const row = element('div', '', 'ready-item');
    row.append(element('span', name), element('b', ready ? '已就绪' : '未就绪', ready ? '' : 'missing'));
    return row;
  }));
  $('installModelButton').hidden = data.ready.summaryModel;
  $('storagePath').textContent = `运行数据：${data.runtimeRoot}`;
}

function renderCreators(data) {
  const creators = data.discovery?.creators || [];
  const available = new Set(creators.map(creator => creator.profileUrl));
  for (const url of selectedCreators) if (!available.has(url)) selectedCreators.delete(url);
  const container = $('creatorList');
  container.replaceChildren();
  $('creatorEmpty').hidden = creators.length > 0;
  for (const creator of creators) {
    const card = element('label', '', 'creator-card');
    const check = element('input');
    check.type = 'checkbox';
    check.disabled = !creator.profileUrl;
    check.checked = selectedCreators.has(creator.profileUrl);
    check.addEventListener('change', () => {
      check.checked ? selectedCreators.add(creator.profileUrl) : selectedCreators.delete(creator.profileUrl);
      updateButtons();
    });
    const main = element('div', '', 'card-main');
    main.append(element('strong', creator.author || '作者待核对'));
    main.append(element('p', creator.reason || '请核对代表作品和主页是否符合学习目标。'));
    main.append(element('p', `${creator.works?.length || 0} 条搜索命中作品 · ${creator.coveredFacets?.join(' / ') || '业务环节待核对'}`));
    main.append(creator.profileUrl ? link(creator.profileUrl, '打开博主主页 ↗') : element('span', '主页链接缺失，不能直接选择', 'selection-hint'));
    card.append(check, main);
    container.append(card);
  }
  updateButtons();
}

function renderWorks(data) {
  const works = data.prepared?.works || [];
  const valid = new Set(works.map(item => item.url));
  for (const url of selectedWorks) if (!valid.has(url)) selectedWorks.delete(url);
  $('worksCount').textContent = works.length ? `已列出 ${works.length} 条作品` : '尚未列出作品';
  $('worksEmpty').hidden = works.length > 0;
  const container = $('worksList');
  container.replaceChildren();
  for (const work of works) {
    const row = element('label', '', 'item-row');
    const check = element('input');
    check.type = 'checkbox';
    check.checked = selectedWorks.has(work.url);
    check.addEventListener('change', () => { check.checked ? selectedWorks.add(work.url) : selectedWorks.delete(work.url); updateButtons(); });
    const main = element('div', '', 'row-main');
    main.append(element('strong', work.title || `作品 ${work.videoId}`));
    const meta = element('p', `作品 ID ${work.videoId} · 先打开原视频核对标题与内容`);
    main.append(meta, link(work.url, '查看原视频 ↗'));
    row.append(check, main, element('span', '待下载', 'badge'));
    container.append(row);
  }
  $('allWorks').checked = works.length > 0 && selectedWorks.size === works.length;
  updateButtons();
}

function transcriptLabel(row) {
  if (row.status === 'completed' && row.hasTranscript) return ['已转写', ''];
  if (row.status === 'failed' || row.status === 'transcription_failed' || row.status === 'permanent_failure') return ['失败', 'fail'];
  return [row.status || '待处理', ''];
}

function renderTranscripts(data) {
  const rows = data.batch?.results || [];
  const allowed = new Set(rows.filter(row => row.status === 'completed' && row.hasTranscript).map(row => String(row.videoId)));
  for (const id of selectedTranscripts) if (!allowed.has(id)) selectedTranscripts.delete(id);
  $('transcriptCount').textContent = rows.length ? `${allowed.size}/${rows.length} 条完成本地转写` : '尚无转写结果';
  $('transcriptsEmpty').hidden = rows.length > 0;
  const container = $('transcriptList');
  container.replaceChildren();
  for (const row of rows) {
    const id = String(row.videoId || '');
    const item = element('div', '', 'item-row');
    const check = element('input');
    check.type = 'checkbox';
    check.disabled = !allowed.has(id);
    check.checked = selectedTranscripts.has(id);
    check.addEventListener('change', () => { check.checked ? selectedTranscripts.add(id) : selectedTranscripts.delete(id); updateButtons(); });
    const main = element('div', '', 'row-main');
    const open = element('button', row.title || `作品 ${id}`);
    open.type = 'button';
    open.disabled = !row.jsonPath;
    open.addEventListener('click', () => previewTranscript(id));
    main.append(open, element('p', id ? `作品 ID ${id}` : '作品 ID 未取得'));
    if (row.lastUserMessage || row.lastError) main.append(element('p', row.lastUserMessage || row.lastError));
    const [label, style] = transcriptLabel(row);
    item.append(check, main, element('span', label, `badge ${style}`));
    container.append(item);
  }
  $('allTranscripts').checked = allowed.size > 0 && selectedTranscripts.size === allowed.size;
  updateButtons();
}

function renderKnowledge(data) {
  const items = data.knowledgeItems || [];
  $('knowledgeEmpty').hidden = items.length > 0;
  const container = $('knowledgeList');
  container.replaceChildren();
  for (const item of items) {
    const row = element('div', '', 'item-row');
    const main = element('div', '', 'row-main');
    const open = element('button', item.title);
    open.type = 'button';
    open.addEventListener('click', () => previewKnowledge(item.videoId));
    main.append(open, element('p', `主题：${item.topic || '待归类'} · 作品 ${item.videoId}`));
    row.append(main, element('span', item.reviewStatus === 'pending' ? '待人工审核' : item.reviewStatus, 'badge'));
    container.append(row);
  }
}

function updateButtons() {
  const busy = Boolean(snapshot?.activeJob);
  const ready = snapshot?.ready || {};
  $('prepareButton').disabled = busy || !ready.cookies || selectedCreators.size === 0;
  $('downloadButton').disabled = busy || !ready.cookies || !ready.transcription || selectedWorks.size === 0;
  $('summarizeButton').disabled = busy || !ready.summaryModel || selectedTranscripts.size === 0;
  $('creatorCount').textContent = selectedCreators.size ? `已选 ${selectedCreators.size} 位博主` : '尚未选择博主';
  $('workSelection').textContent = selectedWorks.size ? `已选 ${selectedWorks.size} 条作品` : '请选择作品';
  $('transcriptSelection').textContent = selectedTranscripts.size ? `已选 ${selectedTranscripts.size} 条文字稿` : '请选择要提炼的文字稿';
  $('allWorks').disabled = busy || !snapshot?.prepared?.works?.length;
  $('allTranscripts').disabled = busy || !snapshot?.batch?.results?.length;
  $('prepareManualButton').disabled = busy || !ready.cookies;
  $('profileInput').disabled = busy;
}

async function refresh() {
  try {
    snapshot = await api('/api/state');
    renderReadiness(snapshot);
    renderCreators(snapshot);
    renderWorks(snapshot);
    renderTranscripts(snapshot);
    renderKnowledge(snapshot);
    if (snapshot.activeJob && !pollingJobId) pollJob(snapshot.activeJob);
  } catch (error) { showError(error); }
}

async function previewTranscript(id) {
  try {
    const record = await api(`/api/transcripts/${id}`);
    const container = $('inspectorContent');
    container.replaceChildren();
    container.append(element('p', '机器转写 / 待人工复核', 'eyebrow'), element('h3', record.title || `作品 ${id}`));
    container.append(link(record.sourceUrl, '查看原视频 ↗'));
    container.append(element('p', '请检查专有名词、数字及遗漏；转写不包含视频画面文字。', 'note'));
    container.append(element('pre', record.transcript || '暂无有效文字稿'));
  } catch (error) { showError(error); }
}

async function previewKnowledge(id) {
  try {
    const record = await api(`/api/knowledge/${id}`);
    const summary = record.summary || {};
    const container = $('inspectorContent');
    container.replaceChildren();
    container.append(element('p', 'AI 草稿 / 待人工审核', 'eyebrow'), element('h3', summary.title || id));
    container.append(element('p', summary.overview || '暂无总览'));
    container.append(link(record.source_url, '查看原视频 ↗'));
    container.append(element('h4', '观点与原文依据'));
    for (const point of summary.points || []) {
      container.append(element('p', point.claim), element('blockquote', point.quote));
    }
    container.append(element('h4', '适用边界'));
    const limits = element('ul');
    for (const item of summary.limitations || []) limits.append(element('li', item));
    container.append(limits, element('h4', '原始机器文字稿'), element('pre', record.transcript || '未提供'));
    const download = link(`/api/knowledge/${id}/markdown`, '下载这条 Markdown ↗');
    download.removeAttribute('target');
    container.append(download);
  } catch (error) { showError(error); }
}

$('refreshButton').addEventListener('click', refresh);
$('loginButton').addEventListener('click', () => startJob('/api/login', {}));
$('installModelButton').addEventListener('click', () => {
  if (window.confirm('将从官方来源下载约 2.5 GB 的本地中文模型到运行目录，并校验 SHA-256。确认开始吗？')) startJob('/api/install-model', {});
});
$('discoverForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!snapshot?.ready.summaryModel) { showError(new Error('本地总结模型未就绪，请先安装。')); return; }
  startJob('/api/discover', { topic: $('topicInput').value.trim() });
});
$('prepareButton').addEventListener('click', () => startJob('/api/prepare', { profileUrls: [...selectedCreators], limit: 20 }));
$('directForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!snapshot?.ready.cookies) { showError(new Error('请先点击左侧“登录 / 更新抖音”。')); return; }
  worksBackRoute = 'source';
  startJob('/api/prepare', { profileUrls: [$('profileInput').value.trim()], limit: 20 });
});
$('prepareButton').addEventListener('click', () => { worksBackRoute = 'creators'; });
$('worksBackButton').addEventListener('click', () => navigate(worksBackRoute));
for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => navigate(button.dataset.back));
}
$('allWorks').addEventListener('change', event => {
  selectedWorks.clear();
  if (event.target.checked) for (const work of snapshot?.prepared?.works || []) selectedWorks.add(work.url);
  renderWorks(snapshot);
});
$('allTranscripts').addEventListener('change', event => {
  selectedTranscripts.clear();
  if (event.target.checked) for (const row of snapshot?.batch?.results || []) if (row.status === 'completed' && row.hasTranscript) selectedTranscripts.add(String(row.videoId));
  renderTranscripts(snapshot);
});
$('downloadButton').addEventListener('click', () => {
  if (window.confirm(`确认下载并在本机转写所选 ${selectedWorks.size} 条视频？不会自动生成知识总结。`)) startJob('/api/download', { urls: [...selectedWorks] });
});
$('summarizeButton').addEventListener('click', () => {
  if (window.confirm(`确认用本机模型提炼所选 ${selectedTranscripts.size} 条文字稿？结果仍需你审核。`)) startJob('/api/summarize', { videoIds: [...selectedTranscripts] });
});

window.addEventListener('hashchange', renderRoute);
renderRoute();
refresh();
