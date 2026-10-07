import { test, expect } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('activity renews login, idle polling does not, and expiry explains the login screen', async ({ page }) => {
  let renewals = 0, renewalStatus = 200, expired = false;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/renew') {
      renewals++;
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-csrf-token']).toBe('test');
      return route.fulfill({ status: renewalStatus, json: renewalStatus === 200 ? { authenticated: true } : { error: 'Authentication required' } });
    }
    const data = path === '/api/auth/session' ? { authenticated: !expired, expired, csrfToken: 'test' }
      : path === '/api/projects' ? { projects: [] }
      : path === '/api/sessions' ? { data: [], nextCursor: null }
      : path === '/api/models' ? { data: [] }
      : path === '/api/permission-modes' ? { modes: [] } : {};
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '新任务', exact: true })).toBeVisible();
  await page.clock.fastForward(2 * 60_000);
  expect(renewals).toBe(0);
  await page.getByRole('textbox', { name: '任务', exact: true }).fill('保持输入时的登录状态');
  await expect.poll(() => renewals).toBe(1);
  await page.keyboard.press('Shift');
  await page.clock.fastForward(60_000);
  await expect.poll(() => renewals).toBe(2);
  await page.clock.fastForward(2 * 60_000);
  expect(renewals).toBe(2);
  renewalStatus = 503;
  await page.keyboard.press('Shift');
  await expect.poll(() => renewals).toBe(3);
  await expect(page.getByRole('heading', { name: '新任务', exact: true })).toBeVisible();
  renewalStatus = 401;
  await page.keyboard.press('Shift');
  await page.clock.fastForward(60_000);
  await expect(page.getByLabel('管理员密码')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('登录已过期或失效');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(tmpdir(), `codex-auth-expired-${width}.png`) });
  }
  const stopped = renewals;
  await page.getByLabel('管理员密码').fill('correct-password-for-test');
  await page.clock.fastForward(2 * 60_000);
  expect(renewals).toBe(stopped);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新任务', exact: true })).toBeVisible();
  expired = true;
  await page.reload();
  await expect(page.getByLabel('管理员密码')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('登录已过期或失效');
  expect(errors).toEqual([]);
});
