/**
 * Render the workbench shell to a real screenshot.
 *
 * The DOM-stub suites prove the CSS *rules* exist; they cannot prove the result
 * looks right. This extracts the plugin's real stylesheet and rebuilds the real
 * markup, then hands it to headless Chrome.
 *
 * It duplicates the markup structure deliberately: this is a VISUAL check of the
 * shell (framing, elevation, spacing, hierarchy), and the structural contract is
 * already asserted against the live bundle by verify-ui-shell.mjs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
const cssStart = src.indexOf('    const CSS = `')
const cssEnd = src.indexOf('\n`', cssStart)
const pluginCss = src.slice(cssStart + '    const CSS = `'.length, cssEnd)

// The plugin relies on DSH theme tokens. Provide a light + dark token set so the
// preview is meaningful rather than falling back to every hardcoded default.
const tokens = (dark) => dark
  ? `--dsw-alias-bg-base:#17181c; --dsw-alias-bg-layer-1:#1d1f24; --dsw-alias-bg-layer-2:#22242a; --dsw-alias-bg-layer-3:#2b2e35;
     --dsw-alias-label-primary:#e8eaed; --dsw-alias-label-secondary:#a8adb8; --dsw-alias-label-tertiary:#7b8290;
     --dsw-alias-border-l1:rgba(255,255,255,.13); --dsw-alias-border-l2:rgba(255,255,255,.2);
     --dsw-alias-brand-primary:#6b86ff; --dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);
     --dsw-alias-bg-mask:rgba(0,0,0,.55);`
  : `--dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-bg-layer-2:#f7f8fa; --dsw-alias-bg-layer-3:rgba(127,127,127,.14);
     --dsw-alias-label-primary:#1f2329; --dsw-alias-label-secondary:#5f6672; --dsw-alias-label-tertiary:#8b93a1;
     --dsw-alias-border-l1:rgba(20,24,32,.12); --dsw-alias-border-l2:rgba(20,24,32,.2);
     --dsw-alias-brand-primary:#4d6bfe; --dsw-alias-interactive-bg-hover:rgba(20,24,32,.06);
     --dsw-alias-bg-mask:rgba(15,18,24,.44);
     --dsw-alias-state-success-primary:#22a06b; --dsw-alias-state-warning-primary:#d9822b; --dsw-alias-state-error-primary:#d64545;`

const STAGES = ['想法', '剧情', '脚本', '设定集', '视觉', '视频']
const STATUS = ['ready', 'ready', 'ready', 'ready', 'running', 'empty']

const steps = STAGES.map((label, i) => `
  <button class="aidrama-step" type="button"${i === 4 ? ' data-active' : ''}>
    <span class="aidrama-stepNum">${i + 1}</span>
    <span>${label}</span>
    <span class="aidrama-dot" data-status="${STATUS[i]}"></span>
  </button>`).join('')

const projects = [
  ['最后一班地铁', '9:16 · 1 集 · 4 张资产', true],
  ['雾港来信', '9:16 · 1 集 · 0 张资产', false],
  ['旧钟表店', '9:16 · 1 集 · 12 张资产', false],
].map(([t, m, active]) => `
  <button class="aidrama-project" type="button"${active ? ' data-active' : ''}>
    <div class="aidrama-projectTitle">${t}</div>
    <div class="aidrama-projectMeta">${m}</div>
  </button>`).join('')

const shots = ['中景 · 推镜头', '特写 · 固定机位'].map((meta, i) => `
  <div class="aidrama-shot">
    <div class="aidrama-shotHead">
      <span class="aidrama-shotNo">镜 ${i + 1}</span>
      <span class="aidrama-shotMeta">${meta}</span>
      <span class="aidrama-tag">已生成</span>
    </div>
    <div class="aidrama-shotBody">林晚对着广播话筒报站，车厢空得只剩她一个人。</div>
    <div class="aidrama-dialog">林晚：下一站，西平路。</div>
  </div>`).join('')

const body = (dark) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  ${tokens(dark)}
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  background: ${dark ? '#101114' : '#eef0f4'};
  /* A fake app behind the modal, so the scrim has something to sit on. */
}
.fakeApp { position: absolute; inset: 0; padding: 28px; color: ${dark ? '#5b6270' : '#9aa1ad'}; font-size: 13px; }
.fakeApp h1 { font-size: 18px; margin: 0 0 10px; }
${pluginCss}
</style></head><body>
  <div class="fakeApp">
    <h1>DeepSeek Harness</h1>
    <p>会话内容在模态层背后，可以被遮罩盖住并虚化。</p>
  </div>

  <div class="aidrama-overlay">
    <div class="aidrama-shell">
      <div class="aidrama-head">
        <h2>短剧工作台</h2>
        <div class="aidrama-headSpacer"></div>
        <span class="aidrama-hint">最后一班地铁</span>
        <button class="aidrama-btn" type="button">设置</button>
        <button class="aidrama-btn" type="button">阶段流程</button>
        <button class="aidrama-btn" type="button">导出 ▾</button>
        <button class="aidrama-btn" data-variant="danger" type="button">删除项目</button>
        <button class="aidrama-iconBtn" type="button" aria-label="关闭" title="关闭（Esc）">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
            <path d="M4.2 4.2l7.6 7.6"></path><path d="M11.8 4.2l-7.6 7.6"></path>
          </svg>
        </button>
      </div>

      <div class="aidrama-body">
        <div class="aidrama-rail">
          <div class="aidrama-railHead">
            <span class="aidrama-railTitle">项目</span>
            <div class="aidrama-headSpacer"></div>
          </div>
          <button class="aidrama-btn" data-variant="primary" type="button">新建短剧</button>
          <div style="height:9px"></div>
          ${projects}
        </div>

        <div class="aidrama-main">
          <div class="aidrama-steps">${steps}</div>
          <div class="aidrama-panel">
            <h3>分镜参考图</h3>
            <div class="aidrama-card">
              <h4>第 1 集 · 第 1 场　地铁车厢 · 夜</h4>
              <p class="aidrama-hint">已锁定角色「林晚」与场景「地铁车厢」，本场共 2 个镜头。</p>
              ${shots}
            </div>
            <div class="aidrama-card">
              <h4>资产</h4>
              <div class="aidrama-grid">
                <div class="aidrama-thumb">
                  <img alt="" src="../out/01-character-sheet.png">
                  <div class="aidrama-thumbName">林晚 · 三视图</div>
                  <div class="aidrama-thumbMeta">1024×1024 · PNG</div>
                </div>
                <div class="aidrama-thumb">
                  <img alt="" src="../out/03-shot-ref.png">
                  <div class="aidrama-thumbName">镜 1 · 参考图</div>
                  <div class="aidrama-thumbMeta">1024×1024 · PNG</div>
                </div>
              </div>
            </div>
            <div class="aidrama-ok">已提交设定集，阶段推进到「视觉资产」。</div>
            <div class="aidrama-row">
              <button class="aidrama-btn" data-variant="primary" type="button">生成视觉资产</button>
              <button class="aidrama-btn" type="button">导出提示词包</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`

const outDir = path.join(root, 'docs', 'realtest', 'ui')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'light.html'), body(false))
fs.writeFileSync(path.join(outDir, 'dark.html'), body(true))
console.log('wrote light.html and dark.html to', outDir)
