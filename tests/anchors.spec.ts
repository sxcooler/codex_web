import { test, expect } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const width of [1280, 390]) test(`Codex document anchors and line references navigate within preview at ${width}px`, async ({ page }) => {
  const errors: string[] = [], reads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('codex-web:panels:v1', JSON.stringify({ version: 1, left: false, right: false }));
    window.EventSource = class extends EventTarget { constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('ready'))); } close() {} } as any;
  });
  const padding = Array.from({ length: 40 }, (_, i) => `段落 ${i}：检查长文档内的定位。`).join('\n\n');
  const document = '# 文档开头\n\n[本页交付](#最近交付) · [下一文档](next.md#下一步) · [重复标题](#最近交付-1)\n\n' + padding + '\n\n## 最近交付\n\n交付详情\n\n' + padding + '\n\n## 最近交付\n\n第二次交付\n\n' + padding + '\n\n```text\nanchor code sample\n```\n\n' + padding;
  const codeLine=document.split('\n').indexOf('anchor code sample')+1;
  const text = '[主要卡点与下一步顺序](C:/work/project/docs/guide.md#最近交付) · [正文行号](C:/work/project/docs/guide.md:81) · [标题行号](docs/guide.md#L85) · [代码块行号](docs/guide.md#L'+codeLine+')\n\n## 最近交付\n\n消息内的同名标题。';
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    let data: any = {};
    if (path === '/api/auth/session') data = { authenticated: true, csrfToken: 'test' };
    else if (path === '/api/projects') data = { projects: [] };
    else if (path === '/api/sessions') data = { data: [], nextCursor: null };
    else if (path === '/api/models') data = { data: [] };
    else if (path === '/api/permission-modes') data = { modes: [] };
    else if (path === '/api/sessions/anchors') data = { project: { id: 'anchor-project', path: 'C:/work/project' }, thread: { id: 'anchors', turns: [{ id: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text }] }] }, phase: 'IDLE', pending: [] };
    else if (path.endsWith('/files')) data = { files: [{ path: 'docs/guide.md', type: 'file' }, { path: 'docs/next.md', type: 'file' }] };
    else if (path.endsWith('/files/content')) { reads.push(url.searchParams.get('path')!); data = { text: url.searchParams.get('path') === 'docs/next.md' ? '# 下一文档\n\n' + padding + '\n\n## 下一步\n\n正确目标\n\n' + padding : document }; }
    await route.fulfill({ json: data });
  });
  await page.goto('/sessions/anchors');
  const chatLink = page.getByRole('link', { name: '主要卡点与下一步顺序', exact: true });
  await expect(chatLink).toBeVisible();
  await chatLink.click();
  const preview = page.getByLabel('文件内容', { exact: true });
  const atTop = async (heading: string, index = 0) => {
    const target = preview.getByRole('heading', { name: heading, exact: true }).nth(index);
    await expect(target).toBeVisible();
    await expect.poll(async () => {
      const box = await target.boundingBox(), container = await preview.boundingBox();
      return Math.abs(box!.y - container!.y);
    }).toBeLessThan(40);
  };
  await atTop('最近交付');
  await page.screenshot({path:join(tmpdir(),`codex-document-anchor-${width}.png`)});
  expect(page.url()).toMatch(/\/sessions\/anchors$/);
  await preview.evaluate(el => el.scrollTop = 0);
  await preview.getByRole('link', { name: '重复标题', exact: true }).click();
  await atTop('最近交付', 1);
  await preview.evaluate(el => el.scrollTop = 0);
  await preview.getByRole('link', { name: '本页交付', exact: true }).click();
  await atTop('最近交付');
  await preview.evaluate(el => el.scrollTop = 0);
  await preview.getByRole('link', { name: '下一文档', exact: true }).click();
  await atTop('下一步');
  expect(reads).toContain('docs/next.md');
  // Reopening an already loaded document must jump again, including in the mobile drawer.
  if (width < 680) await page.locator('[data-panel-toggle="right"][aria-expanded="true"]').click();
  await chatLink.click();
  await atTop('最近交付');
  if (width < 680) await page.locator('[data-panel-toggle="right"][aria-expanded="true"]').click();
  await page.getByRole('link', { name: '正文行号', exact: true }).click();
  await expect(page.getByRole('button', { name: '预览', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const paragraph=preview.locator('p').filter({hasText:'段落 38：检查长文档内的定位。'}).first();
  await expect.poll(async()=>Math.abs((await paragraph.boundingBox())!.y-(await preview.boundingBox())!.y)).toBeLessThan(40);
  if (width < 680) await page.locator('[data-panel-toggle="right"][aria-expanded="true"]').click();
  await page.getByRole('link', { name: '标题行号', exact: true }).click();
  await expect(page.getByRole('button', { name: '预览', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await atTop('最近交付');
  await page.screenshot({path:join(tmpdir(),`codex-line-preview-${width}.png`)});
  if (width < 680) await page.locator('[data-panel-toggle="right"][aria-expanded="true"]').click();
  await page.getByRole('link', { name: '代码块行号', exact: true }).click();
  const code=preview.locator('[data-streamdown="code-block"]');
  await expect.poll(async()=>Math.abs((await code.boundingBox())!.y-(await preview.boundingBox())!.y)).toBeLessThan(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('existing file preview flow keeps Windows/Linux paths, missing-file errors and relative links',async({page})=>{
  for(const suffix of ['', '?linux=1&streaming=1']){
    await page.goto('/tests/document-links.html'+suffix);
    await expect(page.locator('#result')).toContainText('PASS:',{timeout:20_000});
  }
});

test('static and streaming message anchors are scoped and account for inline formatting and duplicate headings',async({page})=>{
  await page.goto('/tests/anchors.html');
  for(const mode of ['false','true']){
    const fixture=page.locator(`[data-fixture="${mode}"]`);
    await expect(fixture.locator('[data-anchor="目标-api-v2"]')).toHaveCount(1);
    await expect(fixture.locator('[data-anchor="目标-api-v2-1"]')).toHaveCount(1);
    await expect(fixture.locator('[data-anchor="目标-api-v2-1-1"]')).toHaveCount(1);
    await fixture.getByRole('link',{name:'定位',exact:true}).click();
    await expect.poll(()=>fixture.evaluate(el=>el.scrollTop)).toBeGreaterThan(100);
    expect(new URL(page.url()).hash).toBe('');
  }
  const ids=await page.locator('.markdown-message [id]').evaluateAll(nodes=>nodes.map(node=>node.id));
  expect(new Set(ids).size).toBe(ids.length);
});
